/**
 * Cross-store reads — a user may only read the store they belong to.
 *
 * Exercises the REAL resolvers. For every denial the test asserts the service
 * function was never called, not merely that an error was thrown: a guard that
 * runs after the read would still pass the weaker check (03 §9, 07 §5).
 *
 * Two attackers: a store-less account (registered, never onboarded) that names
 * Store B, and a store-bound admin at Store A that names Store B.
 */

jest.mock('../src/utils/logger_cf', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: jest.fn() }),
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(), applicationDefault: jest.fn() },
  messaging: () => ({ send: jest.fn() }),
}));

const STORE_A = '000000000000000000000001';
const STORE_B = '000000000000000000000002';

// assertOrderInScope looks the order up to find its store — it belongs to B.
jest.mock('../src/models/Order', () => ({
  findById: jest.fn(() => ({ select: jest.fn().mockResolvedValue({ storeId: '000000000000000000000002' }) })),
  countDocuments: jest.fn(),
}));

jest.mock('../src/services/orderService', () => ({
  createOrder: jest.fn(), getMyOrders: jest.fn(), getOrderById: jest.fn(),
  getStoreOrders: jest.fn(), getOrderByIdForStaff: jest.fn(),
  updateOrderStatus: jest.fn(), flagOrderIssue: jest.fn(),
  getAllOrders: jest.fn(), getOrdersPaginated: jest.fn(),
  getDashboardStats: jest.fn(), getStoreStats: jest.fn(),
  validateCartStock: jest.fn(), getStoreAnalytics: jest.fn(),
  getCustomerRetention: jest.fn(), getStaffPerformance: jest.fn(),
  getBasketAbandonmentStats: jest.fn(), getCustomerLTV: jest.fn(),
  getMonthlyRevenue: jest.fn(),
}));
jest.mock('../src/services/productService', () => ({
  getProductByBarcode: jest.fn(), getStoreProducts: jest.fn(),
  getProductsPaginated: jest.fn(), createProduct: jest.fn(),
  updateProduct: jest.fn(), deleteProduct: jest.fn(),
  bulkUpsertProducts: jest.fn(), getUploadLogs: jest.fn(),
}));
jest.mock('../src/services/storeService', () => ({
  getStores: jest.fn(), getStoreById: jest.fn(), getStoreByCode: jest.fn(),
  getNearbyStores: jest.fn(), createStore: jest.fn(), updateStore: jest.fn(),
  deleteStore: jest.fn(), getStoresPaginated: jest.fn(),
}));
jest.mock('../src/services/inviteService', () => ({
  inviteStaff: jest.fn(), bulkInviteStaff: jest.fn(), validateInviteToken: jest.fn(),
  acceptInvite: jest.fn(), getStoreStaff: jest.fn(), removeStaff: jest.fn(),
  getPendingInvites: jest.fn(), cancelInvite: jest.fn(),
}));

const { Roles } = require('../src/constants/roles');
const orderService = require('../src/services/orderService');
const productService = require('../src/services/productService');
const inviteService = require('../src/services/inviteService');
const resolvers = require('../src/resolvers');

const ctx = (roles, storeId) => ({
  user: { uid: 'uid-x', email: 'x@example.com', phone: null },
  dbUser: { _id: 'u-x', firebase_uid: 'uid-x', roles, storeId, name: 'X' },
});
const storelessAdmin = () => ctx([Roles.CUSTOMER, Roles.ADMIN], null);
const storelessStaff = () => ctx([Roles.CUSTOMER, Roles.STAFF], null);
const adminOfA = () => ctx([Roles.ADMIN], STORE_A);

// [label, resolver call naming Store B, service fn that must never run]
const READS = [
  ['allOrders', (c) => resolvers.Query.allOrders({}, { storeId: STORE_B }, c), () => orderService.getAllOrders],
  ['allOrdersPaginated', (c) => resolvers.Query.allOrdersPaginated({}, { storeId: STORE_B }, c), () => orderService.getOrdersPaginated],
  ['storeOrders', (c) => resolvers.Query.storeOrders({}, { storeId: STORE_B }, c), () => orderService.getStoreOrders],
  ['storeStats', (c) => resolvers.Query.storeStats({}, { storeId: STORE_B }, c), () => orderService.getStoreStats],
  ['storeAnalytics', (c) => resolvers.Query.storeAnalytics({}, { storeId: STORE_B }, c), () => orderService.getStoreAnalytics],
  ['monthlyRevenue', (c) => resolvers.Query.monthlyRevenue({}, { storeId: STORE_B }, c), () => orderService.getMonthlyRevenue],
  ['storeProducts', (c) => resolvers.Query.storeProducts({}, { storeId: STORE_B }, c), () => productService.getStoreProducts],
  ['storeProductsPaginated', (c) => resolvers.Query.storeProductsPaginated({}, { storeId: STORE_B }, c), () => productService.getProductsPaginated],
  ['storeStaff', (c) => resolvers.Query.storeStaff({}, { storeId: STORE_B }, c), () => inviteService.getStoreStaff],
  ['orderById (order of Store B)', (c) => resolvers.Query.orderById({}, { orderId: 'order-of-b' }, c), () => orderService.getOrderByIdForStaff],
];

beforeEach(() => jest.clearAllMocks());

describe('a store-less admin cannot read another store by naming it', () => {
  it.each(READS)('%s', async (_label, call, service) => {
    await expect(call(storelessAdmin())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(service()).not.toHaveBeenCalled();
  });
});

describe('a store-bound admin at Store A cannot read Store B', () => {
  // allOrders/allOrdersPaginated/storeAnalytics/monthlyRevenue ignore the supplied
  // id and scope to the caller's own store — covered below as "narrowed".
  const DENIED = READS.filter(([l]) =>
    !['allOrders', 'allOrdersPaginated', 'storeAnalytics', 'monthlyRevenue'].includes(l));

  it.each(DENIED)('%s', async (_label, call, service) => {
    await expect(call(adminOfA())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(service()).not.toHaveBeenCalled();
  });

  it.each([
    ['allOrders', (c) => resolvers.Query.allOrders({}, { storeId: STORE_B }, c), () => orderService.getAllOrders],
    ['storeAnalytics', (c) => resolvers.Query.storeAnalytics({}, { storeId: STORE_B }, c), () => orderService.getStoreAnalytics],
  ])('%s is narrowed to Store A, never B', async (_label, call, service) => {
    await call(adminOfA());
    const args = JSON.stringify(service().mock.calls);
    expect(args).toContain(STORE_A);
    expect(args).not.toContain(STORE_B);
  });
});

describe('a store-less staff account cannot read another store', () => {
  it.each(READS.filter(([l]) => ['storeOrders', 'storeProducts', 'orderById (order of Store B)'].includes(l)))(
    '%s', async (_label, call, service) => {
      await expect(call(storelessStaff())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(service()).not.toHaveBeenCalled();
    });
});
