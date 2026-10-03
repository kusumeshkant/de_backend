/**
 * Exit flow service (A5 / F-10; 07 §5 priority 7 "exit QR single use").
 *
 * Runs the REAL exitService against an in-memory Order model whose
 * findOneAndUpdate is atomic per document (see helpers/memoryOrders.js), so
 * the race and retry cases exercise the service's conditional write, not a mock.
 */
jest.mock('../src/models/Order', () => require('./helpers/memoryOrders').OrderModel);
jest.mock('../src/models/Store', () => ({ findById: jest.fn().mockResolvedValue({ name: 'DQ UAT Demo Mart', storeCode: 'DQUAT01' }) }));

const db = require('./helpers/memoryOrders');
const Order = require('../src/models/Order');
const exit = require('../src/services/exitService');

const STORE = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER_STORE = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const CUSTOMER = 'cccccccccccccccccccccc01';
const STAFF = { _id: 'dddddddddddddddddddddd01', name: 'Ravi', roles: ['staff'], storeId: STORE };
const STAFF_2 = { _id: 'dddddddddddddddddddddd02', name: 'Asha', roles: ['staff'], storeId: STORE };
const CODE = 'JCTWB6R0XDPGZ5MBVHFXDD1M'; // 24 chars, Crockford base32 (has a 0 and a 1)
const QR = `DQX1:${CODE}`;
const ID = 'eeeeeeeeeeeeeeeeeeeeee01';
const LEGACY_ID = 'eeeeeeeeeeeeeeeeeeeeee02';
const LINES = ['111111111111111111111101', '111111111111111111111102'];

const order = (over = {}) => ({
  _id: ID,
  user: CUSTOMER,
  storeId: STORE,
  status: 'pending',
  paymentStatus: 'success',
  exitCode: CODE,
  exitedAt: null,
  flaggedIssue: null,
  staffActions: [],
  createdAt: new Date('2026-10-03T10:00:00Z'),
  items: [
    { _id: LINES[0], barcode: 'UAT-0001', name: 'Rice', price: 249, quantity: 1, entryMethod: 'manual' },
    { _id: LINES[1], barcode: 'UAT-0002', name: 'Dal', price: 99, quantity: 2, entryMethod: 'scan' },
  ],
  ...over,
});

const scan = (caller = STAFF, over = {}) => ({
  code: QR, caller, isAdmin: false, storeScope: STORE, verifiedLineIds: LINES, requestId: 'req-00000001', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.reset([order()]);
});

describe('exit QR content', () => {
  it('new exit codes are 24 upper-case Crockford characters (no I, L, O, U) and do not repeat', () => {
    const codes = new Set(Array.from({ length: 5000 }, () => exit.newExitCode()));
    expect(codes.size).toBe(5000);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
    // every symbol of the alphabet is used (no stuck bits)
    expect(new Set([...codes].join('')).size).toBe(32);
  });

  it('the owner\'s QR is DQX1:<code>; legacy orders show their id; nothing once exited or cancelled', () => {
    expect(exit.exitQrFor(order())).toBe(QR);
    expect(exit.exitQrFor(order({ exitCode: undefined }))).toBe(ID);
    expect(exit.exitQrFor(order({ exitedAt: new Date() }))).toBeNull();
    expect(exit.exitQrFor(order({ status: 'cancelled' }))).toBeNull();
    expect(exit.exitQrFor(order({ status: 'completed' }))).toBeNull();
  });

  it('accepts the code however a person types it: grouped, any case, no prefix, O/I/L confused', () => {
    for (const typed of [
      QR,
      ` ${QR} `,
      'DQX1: JCTW B6R0 XDPG Z5MB VHFX DD1M',
      'dqx1: jctw b6r0 xdpg z5mb vhfx dd1m',
      'JCTW-B6R0-XDPG-Z5MB-VHFX-DD1M',
      'jctwb6r0xdpgz5mbvhfxdd1m',
      'DQX1: JCTW B6RO XDPG Z5MB VHFX DDIM', // O for 0, I for 1
      'DQX1: JCTW B6Ro XDPG Z5MB VHFX DDlM', // o for 0, l for 1
      'DQX1: JCTW B6R0 XDPG Z5MB VHFX DDLM', // L for 1
    ]) {
      expect(exit.filterForScannedCode(typed)).toEqual({ exitCode: CODE });
    }
  });

  it('a bare 24-hex string may be a legacy order id or a code: both are tried, the id only for pre-cutover orders', () => {
    expect(exit.filterForScannedCode(ID)).toEqual({ $or: [{ exitCode: ID.toUpperCase() }, { _id: ID, exitCode: null }] });
    expect(exit.filterForScannedCode(`DQX1:${ID}`)).toEqual({ exitCode: ID.toUpperCase() }); // prefixed = a code
  });

  it('rejects everything else before any lookup — including the dropped 22-char base64url format', () => {
    for (const bad of [
      '', 'DQX1:', 'DQX1:short', 'hello', `${ID}0`, { $ne: null }, null,
      'DQX1:AbCdEfGhIjKlMnOpQrStUv', // old format
      'DQX1:JCTWB6R0XDPGZ5MBVHFXDD1', // 23
      'DQX1:JCTWB6R0XDPGZ5MBVHFXDD1MM', // 25
      'DQX1:JCTWB6R0XDPGZ5MBVHFXDDUM', // U is not in the alphabet
      'DQX1:JCTWB6R0XDPGZ5MBVHFX_D1M', // symbol
    ]) {
      expect(exit.filterForScannedCode(bad)).toBeNull();
    }
  });
});

describe('verifyExit — read-only', () => {
  it('a paid open order in the caller\'s store is OK_TO_EXIT, with its lines', async () => {
    const r = await exit.verifyExit(scan());
    expect(r.outcome).toBe('OK_TO_EXIT');
    expect(r.order.items.map((i) => i.entryMethod)).toEqual(['manual', 'scan']);
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('another store\'s order is NOT_FOUND (the lookup itself is store-scoped)', async () => {
    db.reset([order({ storeId: OTHER_STORE })]);
    const r = await exit.verifyExit(scan());
    expect(r).toMatchObject({ outcome: 'NOT_FOUND', order: null });
    expect(Order.findOne).toHaveBeenCalledWith({ exitCode: CODE, storeId: STORE });
  });

  it('a raw id of a NEW order (which has an exit code) is NOT_FOUND — ids cannot stand in for codes', async () => {
    const r = await exit.verifyExit(scan(STAFF, { code: ID }));
    expect(r.outcome).toBe('NOT_FOUND');
  });

  it('reports cancelled, unpaid, flagged, own-order and already-exited orders', async () => {
    const cases = [
      [{ status: 'cancelled' }, 'CANCELLED'],
      [{ paymentStatus: 'failed' }, 'NOT_PAID'],
      [{ flaggedIssue: { reason: 'wrong_items', timestamp: new Date() } }, 'FLAGGED'],
      [{ user: STAFF._id }, 'OWN_ORDER'],
      [{ exitedAt: new Date(), exitedBy: { staffName: 'Asha' } }, 'ALREADY_EXITED'],
      [{ status: 'completed', completedAt: new Date() }, 'ALREADY_EXITED'], // legacy completed = exited
    ];
    for (const [over, outcome] of cases) {
      db.reset([order(over)]);
      expect((await exit.verifyExit(scan())).outcome).toBe(outcome);
    }
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('completeExit — single use', () => {
  it('records the exit atomically: completed, exitedAt, who, how, verified lines, audit entry', async () => {
    const r = await exit.completeExit(scan());
    expect(r.outcome).toBe('EXITED');
    const doc = db.stored(ID);
    expect(doc).toMatchObject({
      status: 'completed', exitMethod: 'qr', exitRequestId: 'req-00000001',
      exitedBy: { staffId: STAFF._id, staffName: 'Ravi' }, exitVerifiedLineIds: LINES,
    });
    expect(doc.exitedAt).toBeInstanceOf(Date);
    expect(doc.completedAt).toEqual(doc.exitedAt);
    expect(doc.staffActions).toEqual([expect.objectContaining({ action: 'exited', staffId: STAFF._id })]);
  });

  it('a second scan of the same QR is rejected as ALREADY_EXITED (F-10 closed)', async () => {
    await exit.completeExit(scan());
    const again = await exit.completeExit(scan(STAFF_2, { requestId: 'req-00000002' }));
    expect(again).toMatchObject({ outcome: 'ALREADY_EXITED', exitedByName: 'Ravi' });
    // A GraphQL String: must be ISO-8601, never a Date (sent as epoch ms — seen in UAT).
    expect(again.exitedAt).toBe(db.stored(ID).exitedAt.toISOString());
    const check = await exit.verifyExit(scan(STAFF_2));
    expect(check.outcome).toBe('ALREADY_EXITED');
    expect(db.stored(ID).staffActions).toHaveLength(1);
  });

  it('a retry carrying the same requestId returns EXITED again (lost response), without a second write', async () => {
    await exit.completeExit(scan());
    Order.findOneAndUpdate.mockClear();
    const retry = await exit.completeExit(scan());
    expect(retry.outcome).toBe('EXITED');
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(db.stored(ID).staffActions).toHaveLength(1);
  });

  it('race: five staff completing at once produce exactly one exit', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
      exit.completeExit(scan(n % 2 ? STAFF : STAFF_2, { requestId: `race-request-${n}` }))));
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['ALREADY_EXITED', 'ALREADY_EXITED', 'ALREADY_EXITED', 'ALREADY_EXITED', 'EXITED']);
    expect(db.stored(ID).staffActions.filter((a) => a.action === 'exited')).toHaveLength(1);
  });

  it('race with retries: the same requestId twice plus a competitor still yields one exit', async () => {
    const results = await Promise.all([
      exit.completeExit(scan(STAFF, { requestId: 'req-same-0001' })),
      exit.completeExit(scan(STAFF, { requestId: 'req-same-0001' })),
      exit.completeExit(scan(STAFF_2, { requestId: 'req-other-001' })),
    ]);
    const winner = db.stored(ID).exitRequestId;
    for (const [i, r] of results.entries()) {
      const id = i < 2 ? 'req-same-0001' : 'req-other-001';
      expect(r.outcome).toBe(id === winner ? 'EXITED' : 'ALREADY_EXITED');
    }
    expect(db.stored(ID).staffActions).toHaveLength(1);
  });

  // The order changes between staff's read and the atomic write: the write's own
  // filter must refuse it, and the result must say why.
  const changeAfterRead = (mutate) => {
    const real = Order.findOne.getMockImplementation();
    Order.findOne.mockImplementationOnce(async (f) => {
      const doc = await real(f);
      mutate(db.stored(ID));
      return doc;
    });
  };

  it('cancelled after the read: no exit, reported as CANCELLED', async () => {
    changeAfterRead((d) => { d.status = 'cancelled'; });
    expect((await exit.completeExit(scan())).outcome).toBe('CANCELLED');
    expect(db.stored(ID)).toMatchObject({ status: 'cancelled', exitedAt: null });
  });

  it('flagged after the read: no exit, reported as FLAGGED', async () => {
    changeAfterRead((d) => { d.flaggedIssue = { reason: 'wrong_items', timestamp: new Date() }; });
    expect((await exit.completeExit(scan())).outcome).toBe('FLAGGED');
    expect(db.stored(ID).exitedAt).toBeNull();
  });

  it('payment marked failed after the read: no exit', async () => {
    changeAfterRead((d) => { d.paymentStatus = 'failed'; });
    expect((await exit.completeExit(scan())).outcome).toBe('NOT_PAID');
    expect(db.stored(ID).exitedAt).toBeNull();
  });

  it('wrong store: NOT_FOUND and the write is never called', async () => {
    db.reset([order({ storeId: OTHER_STORE })]);
    const r = await exit.completeExit(scan());
    expect(r.outcome).toBe('NOT_FOUND');
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(db.stored(ID).exitedAt).toBeNull();
  });

  it('staff cannot exit their own order (write never called); an admin can', async () => {
    db.reset([order({ user: STAFF._id })]);
    expect((await exit.completeExit(scan())).outcome).toBe('OWN_ORDER');
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();

    const admin = { ...STAFF, roles: ['admin'] };
    expect((await exit.completeExit(scan(admin, { isAdmin: true }))).outcome).toBe('EXITED');
  });

  it('an open flag blocks the exit (write never called); once an admin clears it the exit works', async () => {
    db.reset([order({ flaggedIssue: { reason: 'wrong_items', staffName: 'Asha', timestamp: new Date() } })]);
    expect((await exit.completeExit(scan())).outcome).toBe('FLAGGED');
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();

    const admin = { _id: 'dddddddddddddddddddddd09', name: 'Owner', roles: ['admin'], storeId: STORE };
    await exit.clearOrderFlag({ orderId: ID, note: 'Recounted, all correct', caller: admin });
    const doc = db.stored(ID);
    expect(doc.flaggedIssue).toMatchObject({ resolutionNote: 'Recounted, all correct', resolvedBy: { staffName: 'Owner' } });
    expect(doc.staffActions).toEqual([expect.objectContaining({ action: 'flag_cleared', staffName: 'Owner' })]);

    expect((await exit.completeExit(scan())).outcome).toBe('EXITED');
  });

  it('clearing needs an open flag and a note', async () => {
    const admin = { _id: 'dddddddddddddddddddddd09', name: 'Owner', roles: ['admin'] };
    await expect(exit.clearOrderFlag({ orderId: ID, note: 'ok', caller: admin }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(exit.clearOrderFlag({ orderId: ID, note: 'Nothing to clear', caller: admin }))
      .rejects.toThrow('no open flag');
  });

  it('every line must be ticked — missing or extra lines are refused before any write', async () => {
    for (const lines of [[LINES[0]], [...LINES, '111111111111111111111199'], [], [LINES[0], LINES[0]]]) {
      expect((await exit.completeExit(scan(STAFF, { verifiedLineIds: lines }))).outcome).toBe('LINES_NOT_VERIFIED');
    }
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cancelled and unpaid orders never exit', async () => {
    for (const [over, outcome] of [[{ status: 'cancelled' }, 'CANCELLED'], [{ paymentStatus: 'failed' }, 'NOT_PAID']]) {
      db.reset([order(over)]);
      expect((await exit.completeExit(scan())).outcome).toBe(outcome);
    }
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a malformed requestId is refused before any read', async () => {
    await expect(exit.completeExit(scan(STAFF, { requestId: 'x' }))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(Order.findOne).not.toHaveBeenCalled();
  });
});

describe('typed with confused characters', () => {
  it('completes the exit, and a second attempt is ALREADY_EXITED', async () => {
    const first = await exit.completeExit(scan(STAFF, { code: 'dqx1: jctw b6ro xdpg z5mb vhfx ddlm' }));
    expect(first.outcome).toBe('EXITED');
    const second = await exit.completeExit(scan(STAFF_2, { code: 'JCTW B6R0 XDPG Z5MB VHFX DD1M', requestId: 'req-00000002' }));
    expect(second.outcome).toBe('ALREADY_EXITED');
  });

  it('invalid input never reaches the database', async () => {
    expect((await exit.verifyExit(scan(STAFF, { code: 'DQX1:AbCdEfGhIjKlMnOpQrStUv' }))).outcome).toBe('NOT_FOUND');
    expect((await exit.completeExit(scan(STAFF, { code: 'not a code' }))).outcome).toBe('NOT_FOUND');
    expect(Order.findOne).not.toHaveBeenCalled();
  });
});

describe('legacy raw-id QR (orders created before exit codes)', () => {
  beforeEach(() => db.reset([order({ _id: LEGACY_ID, exitCode: undefined })]));

  it('is accepted once, then ALREADY_EXITED', async () => {
    const first = await exit.completeExit(scan(STAFF, { code: LEGACY_ID }));
    expect(first.outcome).toBe('EXITED');
    const second = await exit.completeExit(scan(STAFF_2, { code: LEGACY_ID, requestId: 'req-00000002' }));
    expect(second.outcome).toBe('ALREADY_EXITED');
  });

  it('a legacy order already completed under the old flow counts as exited', async () => {
    db.reset([order({ _id: LEGACY_ID, exitCode: undefined, status: 'completed', completedAt: new Date() })]);
    expect((await exit.completeExit(scan(STAFF, { code: LEGACY_ID }))).outcome).toBe('ALREADY_EXITED');
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('manual exit from the open-paid-orders list', () => {
  const manual = (over = {}) => ({
    orderId: ID, reason: 'Phone battery dead, verified name and bag', caller: STAFF, isAdmin: false,
    storeScope: STORE, verifiedLineIds: LINES, requestId: 'manual-000001', ...over,
  });

  it('requires a reason (checked before any read)', async () => {
    for (const reason of ['', '   ', 'abc', 'x'.repeat(501), undefined]) {
      await expect(exit.completeManualExit(manual({ reason }))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    expect(Order.findOne).not.toHaveBeenCalled();
  });

  it('is recorded as a manual exit with the reason, and is single-use too', async () => {
    const r = await exit.completeManualExit(manual());
    expect(r.outcome).toBe('EXITED');
    expect(db.stored(ID)).toMatchObject({ exitMethod: 'manual', exitReason: 'Phone battery dead, verified name and bag' });
    expect(db.stored(ID).staffActions).toEqual([expect.objectContaining({ action: 'manual_exit', note: 'Phone battery dead, verified name and bag' })]);
    expect((await exit.completeManualExit(manual({ requestId: 'manual-000002' }))).outcome).toBe('ALREADY_EXITED');
  });

  it('applies the same own-order, flag and store rules', async () => {
    db.reset([order({ user: STAFF._id })]);
    expect((await exit.completeManualExit(manual())).outcome).toBe('OWN_ORDER');
    db.reset([order({ storeId: OTHER_STORE })]);
    expect((await exit.completeManualExit(manual())).outcome).toBe('NOT_FOUND');
    expect((await exit.completeManualExit(manual({ orderId: 'not-an-id' }))).outcome).toBe('NOT_FOUND');
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('open paid orders', () => {
  it('lists paid, not-exited, not-cancelled orders of that store only, oldest first', async () => {
    const t = (h) => new Date(`2026-10-03T${String(h).padStart(2, '0')}:00:00Z`);
    db.reset([
      order({ _id: 'f00000000000000000000001', createdAt: t(9) }),
      order({ _id: 'f00000000000000000000002', createdAt: t(7), status: 'ready' }),
      order({ _id: 'f00000000000000000000003', createdAt: t(8), paymentStatus: undefined }), // pre-paymentStatus order
      order({ _id: 'f00000000000000000000004', status: 'cancelled' }),
      order({ _id: 'f00000000000000000000005', status: 'completed', exitedAt: t(6) }),
      order({ _id: 'f00000000000000000000006', status: 'completed' }), // legacy exited
      order({ _id: 'f00000000000000000000007', paymentStatus: 'failed' }),
      order({ _id: 'f00000000000000000000008', storeId: OTHER_STORE }),
    ]);
    const list = await exit.getOpenPaidOrders(STORE);
    expect(list.map((o) => String(o._id))).toEqual([
      'f00000000000000000000002', 'f00000000000000000000003', 'f00000000000000000000001',
    ]);
  });
});
