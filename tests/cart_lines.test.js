/**
 * Order lines carry what exit staff need: colour and size snapshotted from the
 * catalogue, and the client's entryMethod hint — through createRazorpayOrder →
 * PendingPayment → Order. Price and name still come only from the catalogue.
 */
const mockDb = { products: new Map(), pending: new Map(), orders: [] };
const mockRzpCreate = jest.fn();

jest.mock('../src/models/Product', () => ({
  findOne: jest.fn(async (filter) => {
    const p = mockDb.products.get(filter.barcode);
    return p && p.storeId === filter.storeId ? { ...p } : null;
  }),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    const p = mockDb.products.get(filter.barcode);
    if (!p || p.stock < filter.stock.$gte) return null;
    p.stock += update.$inc.stock;
    return { ...p };
  }),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../src/models/PendingPayment', () => ({
  create: jest.fn(async (doc) => { mockDb.pending.set(doc.razorpayOrderId, { status: 'pending', ...doc }); return doc; }),
  findOneAndUpdate: jest.fn(async ({ razorpayOrderId }) => {
    const p = mockDb.pending.get(razorpayOrderId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'consumed';
    return { ...p };
  }),
}));
jest.mock('../src/models/Order', () => jest.fn().mockImplementation(function (data) {
  Object.assign(this, data, { _id: `order-${mockDb.orders.length + 1}` });
  this.save = jest.fn(async () => { mockDb.orders.push(this); });
}));
jest.mock('../src/models/CartCheckEvent', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/Store', () => ({ findById: jest.fn().mockResolvedValue({ name: 'S', storeCode: 'S01' }) }));
jest.mock('../src/models/User', () => ({}));
jest.mock('../src/services/notificationService_cf', () => ({ sendNewOrderToStaff: jest.fn().mockResolvedValue() }));
jest.mock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/discountService', () => ({ validateDiscountCode: jest.fn() }));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({ orders: { create: mockRzpCreate } })));

process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
const { createRazorpayOrderFromCart } = require('../src/services/razorpayService');
const { createOrder } = require('../src/services/orderService');

const STORE = 'store-A';
let seq = 0;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.products.clear(); mockDb.pending.clear(); mockDb.orders.length = 0;
  mockDb.products.set('SHIRT', {
    barcode: 'SHIRT', storeId: STORE, name: 'Slim Fit Shirt', price: 999, mrp: 1299, stock: 10,
    color: 'Navy', size: { garment: 'M', actual: 'L' },
  });
  mockDb.products.set('SOCKS', { barcode: 'SOCKS', storeId: STORE, name: 'Socks', price: 199, mrp: 199, stock: 10, size: { actual: 'Free' } });
  mockDb.products.set('BAG', { barcode: 'BAG', storeId: STORE, name: 'Bag', price: 49, stock: 10 });
  mockRzpCreate.mockImplementation(async ({ amount, currency }) => ({ id: `rzp_${++seq}`, amount, currency }));
});

const checkout = (items) => createRazorpayOrderFromCart({ userId: 'user-1', storeId: STORE, items });
const linesOf = async (items) => mockDb.pending.get((await checkout(items)).id).items;

describe('colour and size are snapshotted from the catalogue', () => {
  it('uses the garment label, falls back to the actual size, omits what is missing', async () => {
    const lines = await linesOf([{ barcode: 'SHIRT', quantity: 1 }, { barcode: 'SOCKS', quantity: 1 }, { barcode: 'BAG', quantity: 1 }]);
    expect(lines[0]).toMatchObject({ color: 'Navy', size: 'M' });
    expect(lines[1]).toMatchObject({ size: 'Free' });
    expect(lines[1].color).toBeUndefined();
    expect(lines[2].color).toBeUndefined();
    expect(lines[2].size).toBeUndefined();
  });

  it('ignores client-sent colour, size, name and price', async () => {
    const [line] = await linesOf([{ barcode: 'SHIRT', quantity: 1, name: 'Cheap', price: 1, color: 'Gold', size: 'XXL' }]);
    expect(line).toMatchObject({ name: 'Slim Fit Shirt', price: 999, color: 'Navy', size: 'M' });
  });
});

describe('entryMethod', () => {
  it('defaults to scan; accepts the GraphQL enum or lower case', async () => {
    const lines = await linesOf([
      { barcode: 'SHIRT', quantity: 1 },
      { barcode: 'SOCKS', quantity: 1, entryMethod: 'MANUAL' },
      { barcode: 'BAG', quantity: 1, entryMethod: 'scan' },
    ]);
    expect(lines.map((l) => l.entryMethod)).toEqual(['scan', 'manual', 'scan']);
  });

  it('a merged line is manual if any part was typed in (either order)', async () => {
    expect((await linesOf([{ barcode: 'SHIRT', quantity: 1, entryMethod: 'SCAN' }, { barcode: 'SHIRT', quantity: 1, entryMethod: 'MANUAL' }]))[0])
      .toMatchObject({ quantity: 2, entryMethod: 'manual' });
    expect((await linesOf([{ barcode: 'SHIRT', quantity: 1, entryMethod: 'MANUAL' }, { barcode: 'SHIRT', quantity: 1 }]))[0])
      .toMatchObject({ quantity: 2, entryMethod: 'manual' });
  });

  it.each([['typed'], [''], [1], [{ $ne: null }]])('rejects entryMethod %p before any payment is created', async (entryMethod) => {
    await expect(checkout([{ barcode: 'SHIRT', quantity: 1, entryMethod }]))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(mockRzpCreate).not.toHaveBeenCalled();
    expect(mockDb.pending.size).toBe(0);
  });

  it('does not change the price', async () => {
    const scanned = await checkout([{ barcode: 'SHIRT', quantity: 1 }]);
    const typed = await checkout([{ barcode: 'SHIRT', quantity: 1, entryMethod: 'MANUAL' }]);
    expect(mockDb.pending.get(typed.id).amountPaise).toBe(mockDb.pending.get(scanned.id).amountPaise);
  });
});

describe('through to the Order', () => {
  it('the order lines carry colour, size and entryMethod from the PendingPayment, plus an exit code', async () => {
    const r = await checkout([{ barcode: 'SHIRT', quantity: 1, entryMethod: 'MANUAL' }, { barcode: 'SOCKS', quantity: 2 }]);
    const order = await createOrder({ userId: 'user-1', razorpayOrderId: r.id, razorpayPaymentId: 'pay_1', razorpaySignature: 'verified-upstream' });
    expect(order.items).toEqual([
      expect.objectContaining({ barcode: 'SHIRT', color: 'Navy', size: 'M', entryMethod: 'manual' }),
      expect.objectContaining({ barcode: 'SOCKS', size: 'Free', entryMethod: 'scan', quantity: 2 }),
    ]);
    expect(order.exitCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
    expect(order.status).toBe('pending');
  });
});
