/**
 * Stock decrement race — concurrent orders on the last unit must not oversell
 * (07 §5 test priority 4).
 *
 * Runs the REAL orderService.createOrder several times concurrently against a
 * stateful in-memory Product mock. Each findOneAndUpdate first yields to the
 * event loop (so the concurrent orders genuinely interleave), then evaluates
 * the filter and applies $inc in one synchronous step — the per-document
 * atomicity MongoDB gives findOneAndUpdate. This proves createOrder relies on
 * the conditional atomic update rather than read-then-write; it does not test
 * MongoDB itself (no mongodb-memory-server by decision).
 */

const mockLoggerWarn = jest.fn();
jest.mock('../src/utils/logger_cf', () => ({
  info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn(),
}));

// ── Stateful product collection ──────────────────────────────────────────────
const mockProducts = new Map(); // barcode → document
const mockTick = () => new Promise((resolve) => setImmediate(resolve));

jest.mock('../src/models/Product', () => ({
  findOneAndUpdate: jest.fn(async (filter, update) => {
    await mockTick(); // let the other orders interleave before the atomic step
    const doc = mockProducts.get(filter.barcode);
    if (!doc || doc.storeId !== filter.storeId) return null;
    if (filter.stock && !(doc.stock >= filter.stock.$gte)) return null;
    doc.stock += update.$inc.stock;
    return { ...doc };
  }),
  findByIdAndUpdate: jest.fn(async (id, update) => {
    await mockTick();
    const doc = [...mockProducts.values()].find((d) => d._id === id);
    Object.assign(doc, update);
    return { ...doc };
  }),
}));

jest.mock('../src/models/Order', () =>
  jest.fn().mockImplementation((data) => ({ ...data, _id: `order-${Math.random()}`, save: jest.fn().mockResolvedValue() }))
);
// Each order has its own server PendingPayment (A3: items come from here, not
// from the client). The claim succeeds once per razorpayOrderId.
const mockPending = new Map();
jest.mock('../src/models/PendingPayment', () => ({
  findOneAndUpdate: jest.fn(async ({ razorpayOrderId }) => {
    const p = mockPending.get(razorpayOrderId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'consumed';
    return { ...p };
  }),
  findOne: jest.fn(() => ({ select: jest.fn().mockResolvedValue(null) })),
}));
jest.mock('../src/models/CartCheckEvent', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/Store', () => ({ findById: jest.fn().mockResolvedValue({ name: 'S', storeCode: 'S01' }) }));
jest.mock('../src/models/User', () => ({}));
jest.mock('../src/services/notificationService_cf', () => ({ sendNewOrderToStaff: jest.fn().mockResolvedValue() }));

const Product = require('../src/models/Product');
const { createOrder } = require('../src/services/orderService');

const STORE = 'store-1';
const seed = (stock) => {
  mockProducts.clear();
  mockProducts.set('LAST', { _id: 'p-last', barcode: 'LAST', storeId: STORE, stock, isAvailable: true });
};
const order = (n, quantity = 1) => {
  mockPending.set(`rzp-${n}`, {
    razorpayOrderId: `rzp-${n}`, userId: 'user-1', storeId: STORE, status: 'pending',
    items: [{ barcode: 'LAST', name: 'Tee', price: 100, quantity }],
    subtotal: 100 * quantity, discountAmount: 0, total: 100 * quantity, tax: 18 * quantity, serverTotal: 118 * quantity,
  });
  return createOrder({
    userId: 'user-1', razorpayOrderId: `rzp-${n}`, razorpayPaymentId: `pay-${n}`, razorpaySignature: 'sig',
  });
};
const decrementsApplied = async () =>
  (await Promise.all(Product.findOneAndUpdate.mock.results.map((r) => r.value))).filter(Boolean).length;

beforeEach(() => { jest.clearAllMocks(); mockPending.clear(); });

describe('concurrent orders on the last unit', () => {
  it('two simultaneous orders for the last unit decrement it exactly once', async () => {
    seed(1);
    await Promise.all([order(1), order(2)]);

    const doc = mockProducts.get('LAST');
    expect(doc.stock).toBe(0);                 // never -1
    expect(await decrementsApplied()).toBe(1); // exactly one order took the unit
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toMatch(/Stock insufficient/);
  });

  it('the winner soft-deletes the product; nothing hard-deletes it', async () => {
    seed(1);
    await Promise.all([order(1), order(2)]);

    expect(mockProducts.has('LAST')).toBe(true);
    expect(mockProducts.get('LAST').isAvailable).toBe(false);
    expect(Product.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(Product.findByIdAndUpdate).toHaveBeenCalledWith('p-last', { isAvailable: false, stock: 0 });
  });

  it('five orders against two units sell exactly two', async () => {
    seed(2);
    await Promise.all([1, 2, 3, 4, 5].map((n) => order(n)));

    expect(mockProducts.get('LAST').stock).toBe(0);
    expect(await decrementsApplied()).toBe(2);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(3);
  });

  it('an order for more units than remain takes none', async () => {
    seed(1);
    await order(1, 2);

    expect(mockProducts.get('LAST').stock).toBe(1);
    expect(mockProducts.get('LAST').isAvailable).toBe(true);
    expect(Product.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('every decrement carries the stock guard in its filter', async () => {
    seed(3);
    await Promise.all([order(1), order(2, 2)]);
    for (const [filter, update] of Product.findOneAndUpdate.mock.calls) {
      expect(filter.stock).toEqual({ $gte: -update.$inc.stock });
    }
  });
});
