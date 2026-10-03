/**
 * Exit flow resolvers — guards run before any service call.
 *
 * Exercises the REAL resolvers and the REAL guards (src/utils/guards.js). The
 * exit service is mocked so every denial can assert it was NEVER called — a
 * guard that runs after the read/write would still pass a test that only
 * checks the thrown error (03 §9, 07 §5).
 */
jest.mock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: jest.fn() }), apps: [{}], initializeApp: jest.fn(),
  credential: { cert: jest.fn(), applicationDefault: jest.fn() }, messaging: () => ({ send: jest.fn() }),
}));
// assertOrderInScope (clearOrderFlag) looks up the order's store: it is in store A.
jest.mock('../src/models/Order', () => ({
  findById: jest.fn(() => ({ select: jest.fn().mockResolvedValue({ storeId: '000000000000000000000001' }) })),
}));
jest.mock('../src/models/User', () => ({ findById: jest.fn().mockResolvedValue({ fcmToken: 'fcm-customer' }) }));
jest.mock('../src/services/notificationService_cf', () => ({
  sendOrderConfirmation: jest.fn().mockResolvedValue(), sendOrderStatusUpdate: jest.fn().mockResolvedValue(),
  sendNewOrderToStaff: jest.fn().mockResolvedValue(), sendPermissionRequestNotification: jest.fn().mockResolvedValue(),
  sendPermissionStatusNotification: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/exitService', () => ({
  ...jest.requireActual('../src/services/exitService'),
  verifyExit: jest.fn().mockResolvedValue({ outcome: 'OK_TO_EXIT', message: 'm', order: null }),
  completeExit: jest.fn().mockResolvedValue({ outcome: 'NOT_FOUND', message: 'm', order: null }),
  completeManualExit: jest.fn().mockResolvedValue({ outcome: 'NOT_FOUND', message: 'm', order: null }),
  getOpenPaidOrders: jest.fn().mockResolvedValue([]),
  clearOrderFlag: jest.fn().mockResolvedValue({ _id: 'o' }),
}));

const { Roles } = require('../src/constants/roles');
const exitService = require('../src/services/exitService');
const notifications = require('../src/services/notificationService_cf');
const resolvers = require('../src/resolvers');

const STORE_A = '000000000000000000000001';
const STORE_B = '000000000000000000000002';
const ORDER_ID = '0000000000000000000000aa';

const ctxFor = (dbUser) => ({ user: { uid: `uid-${dbUser._id}` }, dbUser });
const customer = { _id: 'u-cust', roles: [Roles.CUSTOMER], storeId: null };
const staffA = { _id: 'u-staff', name: 'Ravi', roles: [Roles.STAFF], storeId: STORE_A };
const adminA = { _id: 'u-admin', name: 'Owner', roles: [Roles.ADMIN], storeId: STORE_A };
const adminB = { _id: 'u-adminb', name: 'Other', roles: [Roles.ADMIN], storeId: STORE_B };
const storelessStaff = { _id: 'u-nostore', roles: [Roles.STAFF], storeId: null };
const platform = { _id: 'u-plat', roles: [Roles.ADMIN, Roles.PLATFORM_ADMIN], storeId: null };

const exitArgs = { code: 'DQX1:AbCdEfGhIjKlMnOpQrStUv', verifiedLineIds: ['l1'], requestId: 'req-00000001' };
const manualArgs = { orderId: ORDER_ID, reason: 'No phone, checked bag', verifiedLineIds: ['l1'], requestId: 'req-00000001' };

const Q = resolvers.Query;
const M = resolvers.Mutation;
const calls = {
  verifyExit: (ctx) => Q.verifyExit({}, { code: exitArgs.code }, ctx),
  openPaidOrders: (ctx, storeId) => Q.openPaidOrders({}, { storeId }, ctx),
  completeExit: (ctx) => M.completeExit({}, exitArgs, ctx),
  completeManualExit: (ctx) => M.completeManualExit({}, manualArgs, ctx),
  clearOrderFlag: (ctx) => M.clearOrderFlag({}, { orderId: ORDER_ID, note: 'Recounted' }, ctx),
};
const serviceFor = {
  verifyExit: 'verifyExit', openPaidOrders: 'getOpenPaidOrders', completeExit: 'completeExit',
  completeManualExit: 'completeManualExit', clearOrderFlag: 'clearOrderFlag',
};

beforeEach(() => jest.clearAllMocks());

describe('denials — the service is never called', () => {
  it.each(Object.keys(calls))('%s: unauthenticated', async (name) => {
    await expect(calls[name]({})).rejects.toBeDefined();
    expect(exitService[serviceFor[name]]).not.toHaveBeenCalled();
  });

  it.each(Object.keys(calls))('%s: a customer (cannot exit or inspect orders, including their own)', async (name) => {
    await expect(calls[name](ctxFor(customer))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(exitService[serviceFor[name]]).not.toHaveBeenCalled();
  });

  it.each(['verifyExit', 'openPaidOrders', 'completeExit', 'completeManualExit'])(
    '%s: store-less staff', async (name) => {
      await expect(calls[name](ctxFor(storelessStaff))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(exitService[serviceFor[name]]).not.toHaveBeenCalled();
    });

  it('openPaidOrders: staff naming another store', async () => {
    await expect(calls.openPaidOrders(ctxFor(staffA), STORE_B)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(exitService.getOpenPaidOrders).not.toHaveBeenCalled();
  });

  it('openPaidOrders: platform admin must name a store', async () => {
    await expect(calls.openPaidOrders(ctxFor(platform), null)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(exitService.getOpenPaidOrders).not.toHaveBeenCalled();
  });

  it('clearOrderFlag: staff cannot clear flags', async () => {
    await expect(calls.clearOrderFlag(ctxFor(staffA))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(exitService.clearOrderFlag).not.toHaveBeenCalled();
  });

  it('clearOrderFlag: an admin of another store cannot clear this store\'s flag', async () => {
    await expect(calls.clearOrderFlag(ctxFor(adminB))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(exitService.clearOrderFlag).not.toHaveBeenCalled();
  });
});

describe('allowed calls pass the caller\'s store scope and admin flag', () => {
  it('staff: scoped to their store, not an exit admin', async () => {
    await calls.verifyExit(ctxFor(staffA));
    await calls.completeExit(ctxFor(staffA));
    await calls.completeManualExit(ctxFor(staffA));
    for (const fn of ['verifyExit', 'completeExit', 'completeManualExit']) {
      expect(exitService[fn]).toHaveBeenCalledWith(expect.objectContaining({ storeScope: STORE_A, isAdmin: false, caller: staffA }));
    }
    expect(exitService.completeExit).toHaveBeenCalledWith(expect.objectContaining(exitArgs));
  });

  it('admin: scoped to their store, may exit own orders', async () => {
    await calls.completeExit(ctxFor(adminA));
    expect(exitService.completeExit).toHaveBeenCalledWith(expect.objectContaining({ storeScope: STORE_A, isAdmin: true }));
  });

  it('platform admin: any store', async () => {
    await calls.verifyExit(ctxFor(platform));
    expect(exitService.verifyExit).toHaveBeenCalledWith(expect.objectContaining({ storeScope: null, isAdmin: true }));
  });

  it('openPaidOrders: staff get their own store', async () => {
    await calls.openPaidOrders(ctxFor(staffA));
    await calls.openPaidOrders(ctxFor(staffA), STORE_A);
    expect(exitService.getOpenPaidOrders.mock.calls).toEqual([[STORE_A], [STORE_A]]);
  });

  it('clearOrderFlag: admin of the order\'s store', async () => {
    await calls.clearOrderFlag(ctxFor(adminA));
    expect(exitService.clearOrderFlag).toHaveBeenCalledWith({ orderId: ORDER_ID, note: 'Recounted', caller: adminA });
  });

  it('notifies the customer only when the exit actually happened', async () => {
    exitService.completeExit.mockResolvedValueOnce({ outcome: 'EXITED', order: { user: 'u-cust', _storeName: 'S' } });
    await calls.completeExit(ctxFor(staffA));
    await new Promise((r) => setImmediate(r));
    expect(notifications.sendOrderStatusUpdate).toHaveBeenCalledWith('fcm-customer', { status: 'completed', storeName: 'S' });

    notifications.sendOrderStatusUpdate.mockClear();
    exitService.completeExit.mockResolvedValueOnce({ outcome: 'ALREADY_EXITED', order: { user: 'u-cust' } });
    await calls.completeExit(ctxFor(staffA));
    await new Promise((r) => setImmediate(r));
    expect(notifications.sendOrderStatusUpdate).not.toHaveBeenCalled();
  });
});

describe('Order field resolvers', () => {
  const F = resolvers.Order;
  const order = {
    _id: ORDER_ID, user: 'u-cust', status: 'pending', exitCode: 'AbCdEfGhIjKlMnOpQrStUv',
    exitReason: 'No phone', createdAt: new Date(Date.now() - 125 * 60000), flaggedIssue: null,
  };

  it('exitQr is returned only to the order\'s owner', () => {
    expect(F.exitQr(order, {}, ctxFor(customer))).toBe('DQX1:AbCdEfGhIjKlMnOpQrStUv');
    expect(F.exitQr(order, {}, ctxFor(staffA))).toBeNull();
    expect(F.exitQr(order, {}, ctxFor(adminA))).toBeNull();
    expect(F.exitQr(order, {}, ctxFor(platform))).toBeNull();
    expect(F.exitQr(order, {}, {})).toBeNull();
    expect(F.exitQr({ ...order, exitedAt: new Date() }, {}, ctxFor(customer))).toBeNull();
  });

  it('exitReason is hidden from customers', () => {
    expect(F.exitReason(order, {}, ctxFor(customer))).toBeNull();
    expect(F.exitReason(order, {}, ctxFor(staffA))).toBe('No phone');
  });

  it('hasOpenFlag, ageMinutes and line fields', () => {
    expect(F.hasOpenFlag(order)).toBe(false);
    expect(F.hasOpenFlag({ flaggedIssue: { reason: 'x' } })).toBe(true);
    expect(F.hasOpenFlag({ flaggedIssue: { reason: 'x', resolvedAt: new Date() } })).toBe(false);
    expect(F.ageMinutes(order)).toBe(125);
    expect(resolvers.OrderItem.entryMethod({ entryMethod: 'manual' })).toBe('MANUAL');
    expect(resolvers.OrderItem.entryMethod({})).toBe('SCAN');
    expect(resolvers.OrderItem.id({ _id: { toString: () => 'line-1' } })).toBe('line-1');
  });
});
