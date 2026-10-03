/**
 * updateOrderStatus transition rules (Task 6).
 *   - 'completed' is never set here: orders complete only at the exit.
 *   - Only forward moves pending → preparing → ready, or cancel from those.
 *   - Cancel is one atomic conditional write: concurrent cancels restock once,
 *     and an order that has exited cannot be cancelled (no restock of goods
 *     that left the store).
 * Runs the REAL service against the atomic in-memory Order model.
 */
jest.mock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/models/Order', () => require('./helpers/memoryOrders').OrderModel);
jest.mock('../src/models/Store', () => ({ findById: jest.fn().mockResolvedValue({ name: 'S', storeCode: 'S01' }) }));
const mockRestock = jest.fn().mockResolvedValue({});
jest.mock('../src/models/Product', () => ({ findOneAndUpdate: (...a) => mockRestock(...a) }));
jest.mock('../src/models/PendingPayment', () => ({}));
jest.mock('../src/models/CartCheckEvent', () => ({}));
jest.mock('../src/models/User', () => ({}));
jest.mock('../src/services/notificationService_cf', () => ({ sendNewOrderToStaff: jest.fn() }));

const db = require('./helpers/memoryOrders');
const Order = require('../src/models/Order');
const { updateOrderStatus } = require('../src/services/orderService');

const ID = 'eeeeeeeeeeeeeeeeeeeeee01';
const order = (over = {}) => ({
  _id: ID, storeId: 'store-1', status: 'pending', exitedAt: null, staffActions: [],
  items: [{ barcode: 'A', quantity: 2 }, { barcode: 'B', quantity: 1 }], ...over,
});
const set = (status) => updateOrderStatus(ID, status, 'staff-1', 'Ravi');

beforeEach(() => { jest.clearAllMocks(); db.reset([order()]); });

it('allows pending → preparing → ready', async () => {
  await set('preparing');
  await set('ready');
  expect(db.stored(ID).status).toBe('ready');
  expect(db.stored(ID).staffActions.map((a) => a.action)).toEqual(['started_preparing', 'marked_ready']);
});

it.each([
  ['pending', 'ready'], ['ready', 'preparing'], ['preparing', 'pending'], ['cancelled', 'preparing'],
])('refuses %s → %s', async (from, to) => {
  db.reset([order({ status: from })]);
  await expect(set(to)).rejects.toMatchObject({ extensions: { code: 'INVALID_TRANSITION' } });
  expect(db.stored(ID).status).toBe(from);
});

it.each([['pending'], ['ready']])("refuses 'completed' from %s without touching the order", async (from) => {
  db.reset([order({ status: from })]);
  await expect(set('completed')).rejects.toMatchObject({ extensions: { code: 'EXIT_REQUIRED' } });
  expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  expect(db.stored(ID).status).toBe(from);
});

it('cancel restores stock once', async () => {
  await set('cancelled');
  expect(db.stored(ID).status).toBe('cancelled');
  expect(mockRestock).toHaveBeenCalledTimes(2);
});

it('race: three concurrent cancels cancel and restock exactly once', async () => {
  const results = await Promise.allSettled([set('cancelled'), set('cancelled'), set('cancelled')]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(mockRestock).toHaveBeenCalledTimes(2); // two lines, once
  expect(db.stored(ID).staffActions.filter((a) => a.action === 'cancelled')).toHaveLength(1);
});

it('an exited order cannot be cancelled and nothing is restocked', async () => {
  db.reset([order({ status: 'completed', exitedAt: new Date() })]);
  await expect(set('cancelled')).rejects.toThrow('already exited');
  expect(mockRestock).not.toHaveBeenCalled();
  expect(db.stored(ID).status).toBe('completed');
});

it('a legacy completed order (no exitedAt) cannot be cancelled either', async () => {
  db.reset([order({ status: 'completed' })]);
  await expect(set('cancelled')).rejects.toMatchObject({ extensions: { code: 'INVALID_TRANSITION' } });
  expect(mockRestock).not.toHaveBeenCalled();
});
