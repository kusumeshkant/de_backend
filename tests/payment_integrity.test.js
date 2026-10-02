/**
 * A3 — the order is built ONLY from the server's PendingPayment.
 *
 * 07 §5 priority 1 (order from PendingPayment), 3 (duplicate createOrder with the
 * same razorpayOrderId) and S-7 (total + tax = grandTotal), at the service level.
 * Signature verification (priority 2) is in create_order_resolver.test.js.
 *
 * Models are stateful in-memory mocks. findOneAndUpdate yields to the event loop
 * and then matches + updates in one synchronous step — the per-document atomicity
 * MongoDB gives — so concurrent calls genuinely interleave.
 */

const tick = () => new Promise((r) => setImmediate(r));

// ── In-memory collections ────────────────────────────────────────────────────
const mockDb = { products: new Map(), pending: new Map(), orders: [] };
const mockRzpCreate = jest.fn();
const mockValidateDiscount = jest.fn();

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(doc[k] ?? null);
  if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
  if (v && typeof v === 'object' && '$gte' in v) return doc[k] >= v.$gte;
  return String(doc[k]) === String(v);
});

jest.mock('../src/models/Product', () => ({
  findOne: jest.fn(async (filter) => {
    const p = mockDb.products.get(filter.barcode);
    return p && matches(p, filter) ? { ...p } : null;
  }),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    await tick();
    const p = mockDb.products.get(filter.barcode);
    if (!p || !matches(p, filter)) return null;
    p.stock += update.$inc.stock;
    return { ...p };
  }),
  findByIdAndUpdate: jest.fn(async (id, update) => {
    const p = [...mockDb.products.values()].find((x) => x._id === id);
    Object.assign(p, update);
    return { ...p };
  }),
}));

jest.mock('../src/models/PendingPayment', () => ({
  create: jest.fn(async (doc) => { mockDb.pending.set(doc.razorpayOrderId, { status: 'pending', ...doc }); return doc; }),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    await tick();
    const p = mockDb.pending.get(filter.razorpayOrderId);
    if (!p || !matches(p, filter)) return null;
    Object.assign(p, update.$set);
    for (const k of Object.keys(update.$unset || {})) delete p[k];
    return { ...p };
  }),
  findOne: jest.fn((filter) => {
    const p = mockDb.pending.get(filter.razorpayOrderId);
    const hit = p && matches(p, filter) ? { ...p } : null;
    return Object.assign(Promise.resolve(hit), { select: () => Promise.resolve(p ? { ...p } : null) });
  }),
}));

jest.mock('../src/models/Order', () => {
  const MockOrder = jest.fn().mockImplementation(function (data) {
    Object.assign(this, data, { _id: `order-${mockDb.orders.length + 1}` });
    this.save = jest.fn(async () => {
      await tick();
      if (mockDb.orders.some((o) => o.razorpayOrderId === this.razorpayOrderId)) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      mockDb.orders.push(this);
    });
  });
  MockOrder.findOne = jest.fn(async (filter) => mockDb.orders.find((o) =>
    o.razorpayOrderId === filter.razorpayOrderId && String(o.user) === String(filter.user)) ?? null);
  return MockOrder;
});

jest.mock('../src/models/CartCheckEvent', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/Store', () => ({ findById: jest.fn().mockResolvedValue({ name: 'S', storeCode: 'S01' }) }));
jest.mock('../src/models/User', () => ({}));
jest.mock('../src/services/notificationService_cf', () => ({ sendNewOrderToStaff: jest.fn().mockResolvedValue() }));
jest.mock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/discountService', () => ({ validateDiscountCode: mockValidateDiscount }));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({ orders: { create: mockRzpCreate } })));

process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
const { createRazorpayOrderFromCart } = require('../src/services/razorpayService');
const { createOrder } = require('../src/services/orderService');
const Order = require('../src/models/Order');

const STORE = 'store-A';
const OTHER_STORE = 'store-B';
const USER = 'user-1';
let rzpSeq = 0;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.products.clear(); mockDb.pending.clear(); mockDb.orders.length = 0;
  mockDb.products.set('RICE', { _id: 'p-rice', barcode: 'RICE', storeId: STORE, name: 'Basmati Rice', price: 249, mrp: 299, stock: 40, isAvailable: true });
  mockDb.products.set('OIL', { _id: 'p-oil', barcode: 'OIL', storeId: STORE, name: 'Sunflower Oil', price: 189.5, mrp: 199, stock: 2, isAvailable: true });
  mockDb.products.set('GONE', { _id: 'p-gone', barcode: 'GONE', storeId: STORE, name: 'Old', price: 10, stock: 0, isAvailable: false });
  mockRzpCreate.mockImplementation(async ({ amount, currency }) => ({ id: `rzp_order_${++rzpSeq}`, amount, currency }));
});

const checkout = (items, discountCode = null) => createRazorpayOrderFromCart({ userId: USER, storeId: STORE, items, discountCode });
const pay = (razorpayOrderId, userId = USER) => createOrder({ userId, razorpayOrderId, razorpayPaymentId: `pay_${razorpayOrderId}`, razorpaySignature: 'verified-upstream' });

// ── createRazorpayOrder: server builds the line items and totals ─────────────
describe('createRazorpayOrderFromCart — server-built line items and totals', () => {
  it('ignores client price and name; uses the catalogue', async () => {
    const r = await checkout([{ barcode: 'RICE', name: 'FREE STUFF', price: 1, quantity: 2 }]);
    const pending = mockDb.pending.get(r.id);
    expect(pending.items).toEqual([expect.objectContaining({ barcode: 'RICE', name: 'Basmati Rice', price: 249, mrp: 299, quantity: 2 })]);
    expect(pending.subtotal).toBe(498);
  });

  it('charges Razorpay exactly the server grand total, and returns the key', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 1 }, { barcode: 'OIL', quantity: 1 }]);
    const p = mockDb.pending.get(r.id);
    // 249 + 189.50 = 438.50; GST 78.93; grand 517.43
    expect(p).toEqual(expect.objectContaining({ subtotal: 438.5, discountAmount: 0, total: 438.5, tax: 78.93, serverTotal: 517.43, amountPaise: 51743 }));
    expect(mockRzpCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 51743, currency: 'INR' }));
    expect(r.keyId).toBe('rzp_test_unit');
  });

  it('merges duplicate barcodes into one line', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 1 }, { barcode: 'RICE', quantity: 2 }]);
    expect(mockDb.pending.get(r.id).items).toEqual([expect.objectContaining({ barcode: 'RICE', quantity: 3 })]);
  });

  it.each([[0], [-1], [1.5], [100], ['2']])('rejects quantity %p before any payment is created', async (quantity) => {
    await expect(checkout([{ barcode: 'RICE', quantity }])).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(mockRzpCreate).not.toHaveBeenCalled();
    expect(mockDb.pending.size).toBe(0);
  });

  it('rejects an empty cart', async () => {
    await expect(checkout([])).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(mockRzpCreate).not.toHaveBeenCalled();
  });

  it('rejects an unavailable (soft-deleted) product', async () => {
    await expect(checkout([{ barcode: 'GONE', quantity: 1 }])).rejects.toMatchObject({ extensions: { code: 'PRODUCT_UNAVAILABLE' } });
    expect(mockRzpCreate).not.toHaveBeenCalled();
  });

  it('rejects more units than are in stock', async () => {
    await expect(checkout([{ barcode: 'OIL', quantity: 3 }])).rejects.toMatchObject({ extensions: { code: 'OUT_OF_STOCK' } });
    expect(mockRzpCreate).not.toHaveBeenCalled();
  });
});

// ── S-7: totals add up, discount recorded ────────────────────────────────────
describe('S-7 — total + tax = grandTotal, discount recorded', () => {
  it('discounted order: total is the discounted subtotal and the parts add up exactly', async () => {
    mockValidateDiscount.mockResolvedValue({ finalAmount: 448.2, discountAmount: 49.8 }); // 10% off 498
    const r = await checkout([{ barcode: 'RICE', quantity: 2 }], ' save10 ');
    const p = mockDb.pending.get(r.id);
    expect(mockValidateDiscount).toHaveBeenCalledWith({ code: 'SAVE10', storeId: STORE, subtotal: 498 });
    expect(p).toEqual(expect.objectContaining({ subtotal: 498, discountAmount: 49.8, total: 448.2, tax: 80.68, serverTotal: 528.88, discountCode: 'SAVE10' }));

    const order = await pay(r.id);
    expect(order.total).toBe(448.2);
    expect(order.tax).toBe(80.68);
    expect(order.discountAmount).toBe(49.8);
    expect(Math.round((order.total + order.tax) * 100)).toBe(Math.round(order.grandTotal * 100));
  });

  it('holds for awkward prices too (paise arithmetic, no float drift)', async () => {
    mockDb.products.get('OIL').stock = 50;
    const r = await checkout([{ barcode: 'OIL', quantity: 7 }]);
    const order = await pay(r.id);
    expect(Math.round(order.total * 100) + Math.round(order.tax * 100)).toBe(Math.round(order.grandTotal * 100));
    expect(mockRzpCreate.mock.calls[0][0].amount).toBe(Math.round(order.grandTotal * 100));
  });
});

// ── 07 §5 priority 1: the order comes from PendingPayment ────────────────────
describe('createOrder — the order is built only from PendingPayment', () => {
  it('store, items and totals come from the server record; stock decrements from that same list', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 2 }]);
    const order = await pay(r.id);
    expect(order).toEqual(expect.objectContaining({
      storeId: STORE, total: 498, tax: 89.64, grandTotal: 587.64, discountAmount: 0, paymentStatus: 'success',
    }));
    expect(order.items).toEqual([expect.objectContaining({ barcode: 'RICE', name: 'Basmati Rice', price: 249, quantity: 2 })]);
    expect(mockDb.products.get('RICE').stock).toBe(38);
    expect(mockDb.products.get('OIL').stock).toBe(2); // untouched
  });

  it('createOrder accepts no client items/totals/store at all', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 1 }]);
    // Even if a caller smuggled extra fields in, they are not read.
    const order = await createOrder({
      userId: USER, razorpayOrderId: r.id, razorpayPaymentId: 'pay_x', razorpaySignature: 's',
      storeId: OTHER_STORE, items: [{ barcode: 'OIL', price: 1, quantity: 2 }], total: 1, tax: 0, grandTotal: 1,
    });
    expect(order.storeId).toBe(STORE);
    expect(order.items.map((i) => i.barcode)).toEqual(['RICE']);
    expect(order.grandTotal).toBe(293.82);
    expect(mockDb.products.get('OIL').stock).toBe(2);
  });

  it("another user's payment session is refused and nothing is written", async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 1 }]);
    await expect(pay(r.id, 'intruder')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(mockDb.orders).toHaveLength(0);
    expect(mockDb.pending.get(r.id).status).toBe('pending');
    expect(mockDb.products.get('RICE').stock).toBe(40);
  });

  it('an unknown or expired payment session is refused', async () => {
    await expect(pay('rzp_order_never')).rejects.toMatchObject({ extensions: { code: 'PAYMENT_SESSION_NOT_FOUND' } });
    expect(Order).not.toHaveBeenCalled();
  });

  it('consumes the session and keeps it for audit (expiresAt removed)', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 1 }]);
    await pay(r.id);
    const p = mockDb.pending.get(r.id);
    expect(p.status).toBe('consumed');
    expect(p.razorpayPaymentId).toBe(`pay_${r.id}`);
    expect(p).not.toHaveProperty('expiresAt');
  });

  it('honours a pre-A3 pending record (no status/total) with derived totals', async () => {
    mockDb.pending.set('rzp_legacy', {
      razorpayOrderId: 'rzp_legacy', userId: USER, storeId: STORE, serverTotal: 118,
      items: [{ barcode: 'RICE', name: 'Basmati Rice', price: 100, quantity: 1 }],
    });
    const order = await pay('rzp_legacy');
    expect(order.grandTotal).toBe(118);
    expect(order.total).toBe(100);
    expect(order.tax).toBe(18);
  });
});

// ── 07 §5 priority 3: duplicate createOrder with the same razorpayOrderId ─────
describe('duplicate createOrder for one Razorpay order', () => {
  it('sequential repeat returns the same order — no second order, no second decrement', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 2 }]);
    const first = await pay(r.id);
    const second = await pay(r.id);
    expect(second._id).toBe(first._id);
    expect(mockDb.orders).toHaveLength(1);
    expect(mockDb.products.get('RICE').stock).toBe(38);
    // The atomic claim — not just the unique-index backstop — stops the repeat:
    // a second Order is never even constructed.
    expect(Order).toHaveBeenCalledTimes(1);
  });

  it('concurrent repeats produce exactly one order and one decrement', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 2 }]);
    const results = await Promise.allSettled([pay(r.id), pay(r.id), pay(r.id)]);
    expect(mockDb.orders).toHaveLength(1);
    expect(mockDb.products.get('RICE').stock).toBe(38);
    expect(Order).toHaveBeenCalledTimes(1); // only the claim winner builds an Order
    // Each loser either got the same order back or was told it is in progress — never a second order.
    for (const res of results) {
      if (res.status === 'fulfilled') expect(res.value._id).toBe(mockDb.orders[0]._id);
      else expect(res.reason.extensions.code).toBe('ORDER_IN_PROGRESS');
    }
  });

  it('the unique index backstop returns the existing order if two saves ever race', async () => {
    const r = await checkout([{ barcode: 'RICE', quantity: 1 }]);
    const first = await pay(r.id);
    // Simulate a second claim succeeding (e.g. legacy record) — save hits E11000.
    mockDb.pending.get(r.id).status = 'pending';
    const again = await pay(r.id);
    expect(again._id).toBe(first._id);
    expect(mockDb.orders).toHaveLength(1);
  });
});
