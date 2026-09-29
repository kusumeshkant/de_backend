/**
 * Step 1 verification — platform-admin privilege gap.
 *
 * Exercises the REAL resolvers (not a re-implementation) to prove that a
 * freshly registerAdmin'd account — admin role, no storeId — is rejected from
 * every platform-scoped operation, while an explicit PLATFORM_ADMIN is allowed.
 *
 * Services are mocked so no database is required. The guards throw before any
 * service call in the rejection cases; the mocks only matter for the positive
 * control assertions.
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

jest.mock('../src/services/orderService', () => ({
  createOrder: jest.fn(), getMyOrders: jest.fn(), getOrderById: jest.fn(),
  getStoreOrders: jest.fn(), getOrderByIdForStaff: jest.fn(),
  updateOrderStatus: jest.fn(), flagOrderIssue: jest.fn(),
  getAllOrders: jest.fn().mockResolvedValue([{ id: 'o1' }]),
  getOrdersPaginated: jest.fn().mockResolvedValue({ items: [] }),
  getDashboardStats: jest.fn().mockResolvedValue({ totalRevenue: 999 }),
  getStoreStats: jest.fn().mockResolvedValue({ store: null, totalRevenue: 1, totalOrders: 0, pendingOrders: 0, completedOrders: 0, recentOrders: [] }),
  validateCartStock: jest.fn(), getStoreAnalytics: jest.fn(),
  getCustomerRetention: jest.fn(), getStaffPerformance: jest.fn(),
  getBasketAbandonmentStats: jest.fn(),
  getCustomerLTV: jest.fn().mockResolvedValue({ totalCustomers: 7, topCustomers: [] }),
  getMonthlyRevenue: jest.fn(),
}));
jest.mock('../src/services/storeService', () => ({
  getStores: jest.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
  getStoreById: jest.fn().mockResolvedValue({ id: 's1' }),
  getStoreByCode: jest.fn(), getNearbyStores: jest.fn(),
  createStore: jest.fn(), updateStore: jest.fn(), deleteStore: jest.fn(),
  getStoresPaginated: jest.fn().mockResolvedValue({ items: [] }),
}));
jest.mock('../src/services/subscription_service', () => ({
  getStoreSubscription: jest.fn(), getAvailablePlans: jest.fn(),
  activatePlan: jest.fn(), cancelSubscription: jest.fn(),
  setAdminOverride: jest.fn().mockResolvedValue({ _id: 'sub1' }),
  checkSubscriptionExpirySweep: jest.fn().mockResolvedValue({
    enteredGracePeriod: [], expired: [], errors: [],
  }),
}));
jest.mock('../src/services/feature_access_service', () => ({
  getFeatureAccessMap: jest.fn(),
  assertFeatureAccess: jest.fn().mockResolvedValue(undefined),
}));

const { Roles } = require('../src/constants/roles');
const resolvers = require('../src/resolvers');

const STORE_A = '000000000000000000000001';

/** Context for a brand-new registerAdmin'd account — admin role, no store. */
const freshAdminCtx = () => ({
  user: { uid: 'uid-fresh', email: 'fresh@example.com', phone: null },
  dbUser: {
    _id: 'u-fresh', firebase_uid: 'uid-fresh',
    roles: [Roles.CUSTOMER, Roles.ADMIN], storeId: null, name: 'Fresh',
  },
});

/** Context for an explicitly granted platform operator. */
const platformAdminCtx = () => ({
  user: { uid: 'uid-plat', email: 'ops@dqstore.in', phone: null },
  dbUser: {
    _id: 'u-plat', firebase_uid: 'uid-plat',
    roles: [Roles.ADMIN, Roles.PLATFORM_ADMIN], storeId: null, name: 'Ops',
  },
});

const PLATFORM_DENIED = /platform administrator/i;

describe('Step 1 — a store-less admin is denied every platform-scoped operation', () => {
  it('allOrders', async () => {
    await expect(resolvers.Query.allOrders({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('allOrdersPaginated', async () => {
    await expect(resolvers.Query.allOrdersPaginated({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('dashboardStats', async () => {
    await expect(resolvers.Query.dashboardStats({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('customerLTV', async () => {
    await expect(resolvers.Query.customerLTV({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('stores', async () => {
    await expect(resolvers.Query.stores({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('allStaff', async () => {
    await expect(resolvers.Query.allStaff({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('staffPerformance', async () => {
    await expect(resolvers.Query.staffPerformance({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('basketAbandonment', async () => {
    await expect(resolvers.Query.basketAbandonment({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('customerRetention', async () => {
    await expect(resolvers.Query.customerRetention({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('storeAnalytics', async () => {
    await expect(resolvers.Query.storeAnalytics({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('monthlyRevenue', async () => {
    await expect(resolvers.Query.monthlyRevenue({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });

  it('setAdminSubscriptionOverride', async () => {
    await expect(resolvers.Mutation.setAdminSubscriptionOverride(
      {}, { storeId: STORE_A, planName: 'enterprise', days: 365 }, freshAdminCtx()
    )).rejects.toThrow(PLATFORM_DENIED);
  });

  it('runSubscriptionExpirySweep', async () => {
    await expect(resolvers.Mutation.runSubscriptionExpirySweep({}, {}, freshAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });
});

describe('Step 1 — an explicit PLATFORM_ADMIN retains platform access', () => {
  it('allOrders returns data', async () => {
    await expect(resolvers.Query.allOrders({}, {}, platformAdminCtx()))
      .resolves.toEqual([{ id: 'o1' }]);
  });

  it('dashboardStats returns platform totals', async () => {
    const stats = await resolvers.Query.dashboardStats({}, {}, platformAdminCtx());
    expect(stats.totalRevenue).toBe(999);
  });

  it('customerLTV returns data', async () => {
    const ltv = await resolvers.Query.customerLTV({}, {}, platformAdminCtx());
    expect(ltv.totalCustomers).toBe(7);
  });

  it('stores lists every store', async () => {
    await expect(resolvers.Query.stores({}, {}, platformAdminCtx()))
      .resolves.toHaveLength(2);
  });

  it('setAdminSubscriptionOverride is permitted', async () => {
    await expect(resolvers.Mutation.setAdminSubscriptionOverride(
      {}, { storeId: STORE_A, planName: 'enterprise', days: 30 }, platformAdminCtx()
    )).resolves.toBeDefined();
  });

  it('runSubscriptionExpirySweep is permitted', async () => {
    const res = await resolvers.Mutation.runSubscriptionExpirySweep({}, {}, platformAdminCtx());
    expect(res.errorCount).toBe(0);
  });
});

describe('Step 1 — a store-bound admin stays scoped to its own store', () => {
  const storeAdminCtx = () => ({
    user: { uid: 'uid-store', email: 'a@store.com', phone: null },
    dbUser: {
      _id: 'u-store', firebase_uid: 'uid-store',
      roles: [Roles.ADMIN], storeId: STORE_A, name: 'Store Admin',
    },
  });

  it('allOrders is filtered to the caller store even when another id is supplied', async () => {
    const orderService = require('../src/services/orderService');
    orderService.getAllOrders.mockClear();
    await resolvers.Query.allOrders({}, { storeId: '000000000000000000000002' }, storeAdminCtx());
    expect(orderService.getAllOrders).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE_A })
    );
  });

  it('stores returns only the caller store', async () => {
    await expect(resolvers.Query.stores({}, {}, storeAdminCtx())).resolves.toHaveLength(1);
  });

  it('cannot run platform-only mutations', async () => {
    await expect(resolvers.Mutation.runSubscriptionExpirySweep({}, {}, storeAdminCtx()))
      .rejects.toThrow(PLATFORM_DENIED);
  });
});

describe('Step 1 — PLATFORM_ADMIN is not grantable through the API', () => {
  it('updateUserRole refuses to assign it', async () => {
    await expect(resolvers.Mutation.updateUserRole(
      {}, { userId: 'u-victim', role: Roles.PLATFORM_ADMIN, storeId: STORE_A },
      { user: { uid: 'uid-store' }, dbUser: { _id: 'u-store', firebase_uid: 'uid-store', roles: [Roles.ADMIN], storeId: STORE_A } }
    )).rejects.toThrow(/cannot be assigned through the API/);
  });
});
