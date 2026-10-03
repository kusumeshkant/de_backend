/**
 * Revenue = paid and not cancelled (decision 2, Task 6), in every report.
 *
 * Before the exit flow, revenue counted only status 'completed'. Paid orders
 * that have not exited yet are real money, so every report now counts
 * paymentStatus success (or missing, on orders older than the field) and
 * status != cancelled. The same fixture runs through all six reports plus the
 * store dashboard's weekly figures, which used to be hard-coded to 0.
 */
jest.mock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/models/Order', () => require('./helpers/memoryOrders').OrderModel);
jest.mock('../src/models/Store', () => ({
  find: jest.fn().mockResolvedValue([{ _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'DQ UAT Demo Mart', storeCode: 'DQUAT01' }]),
  findById: jest.fn().mockResolvedValue({ _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'DQ UAT Demo Mart', storeCode: 'DQUAT01' }),
}));
jest.mock('../src/models/Product', () => ({ countDocuments: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/models/User', () => ({
  find: jest.fn(() => ({ select: jest.fn().mockResolvedValue([
    { _id: 'cccccccccccccccccccccc01', name: 'Asha' }, { _id: 'cccccccccccccccccccccc02', name: 'Ravi' },
  ]) })),
}));
jest.mock('../src/models/PendingPayment', () => ({}));
jest.mock('../src/models/CartCheckEvent', () => ({}));
jest.mock('../src/services/notificationService_cf', () => ({ sendNewOrderToStaff: jest.fn() }));

const db = require('./helpers/memoryOrders');
const os = require('../src/services/orderService');

const STORE = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const U1 = 'cccccccccccccccccccccc01';
const U2 = 'cccccccccccccccccccccc02';
const U3 = 'cccccccccccccccccccccc03';

// Same week boundaries as the service (local time, week starts Sunday).
const startOfThisWeek = (() => {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
})();
const thisWeek = new Date(Date.now() - 60 * 1000);
const lastWeek = new Date(startOfThisWeek.getTime() - 3 * 24 * 3600 * 1000);

const o = (id, user, grandTotal, over) => ({
  _id: `bbbbbbbbbbbbbbbbbbbbbb${id}`, user, storeId: STORE, grandTotal, total: grandTotal, tax: 0,
  status: 'pending', paymentStatus: 'success', createdAt: thisWeek, staffActions: [],
  items: [{ barcode: `B${id}`, name: `Item ${id}`, price: grandTotal, mrp: grandTotal, quantity: 1 }],
  ...over,
});

const ORDERS = [
  o('01', U1, 100, {}),                                                         // paid, not exited yet → revenue
  o('02', U1, 200, { status: 'completed', exitedAt: thisWeek, completedAt: thisWeek,
    staffActions: [{ staffId: 's1', staffName: 'Ravi', action: 'exited' }] }),   // exited → revenue
  o('03', U3, 400, { status: 'cancelled' }),                                    // cancelled → not revenue
  o('04', U3, 800, { paymentStatus: 'failed' }),                                // not paid → not revenue
  o('05', U2, 1600, { status: 'completed', paymentStatus: undefined, completedAt: thisWeek,
    staffActions: [{ staffId: 's1', staffName: 'Ravi', action: 'completed' }] }), // pre-paymentStatus order → revenue
  o('06', U2, 3200, { createdAt: lastWeek,
    staffActions: [{ staffId: 's2', staffName: 'Asha', action: 'manual_exit' }] }), // last week, paid → revenue
];
const REVENUE = 100 + 200 + 1600 + 3200; // 5100 — the old 'completed only' rule gives 1800
const THIS_WEEK = 100 + 200 + 1600;
const LAST_WEEK = 3200;

beforeEach(() => db.reset(ORDERS));

describe('revenue rule', () => {
  it('isRevenue / REVENUE_FILTER agree: paid (or no field) and not cancelled', () => {
    const viaFn = ORDERS.filter(os.isRevenue).map((x) => x._id);
    const viaFilter = ORDERS.filter((x) => db.matches(x, os.REVENUE_FILTER)).map((x) => x._id);
    expect(viaFn).toEqual(viaFilter);
    expect(viaFn.map((id) => id.slice(-2))).toEqual(['01', '02', '05', '06']);
  });
});

describe('every report uses it', () => {
  it('1. platform dashboard: total, per-store and weekly revenue', async () => {
    const s = await os.getDashboardStats();
    expect(s.totalRevenue).toBe(REVENUE);
    expect(s.topStores[0]).toMatchObject({ revenue: REVENUE, orderCount: 4 });
    expect(s.thisWeekRevenue).toBe(THIS_WEEK);
    expect(s.lastWeekRevenue).toBe(LAST_WEEK);
    expect(s.completedOrders).toBe(2); // status count, unchanged meaning
  });

  it('2. store stats: total and weekly revenue', async () => {
    const s = await os.getStoreStats(STORE);
    expect(s.totalRevenue).toBe(REVENUE);
    expect(s.thisWeekRevenue).toBe(THIS_WEEK);
    expect(s.lastWeekRevenue).toBe(LAST_WEEK);
  });

  it('3. store analytics: revenue, AOV, products, daily, peak hours/days', async () => {
    const a = await os.getStoreAnalytics(STORE);
    expect(a.totalRevenue).toBe(REVENUE);
    expect(a.avgOrderValue).toBe(REVENUE / 4);
    expect(a.topProducts.reduce((s, p) => s + p.revenue, 0)).toBe(REVENUE);
    expect(a.thisWeekRevenue).toBe(THIS_WEEK);
    expect(a.lastWeekRevenue).toBe(LAST_WEEK);
    expect(a.dailyRevenue.reduce((s, d) => s + d.revenue, 0)).toBe(REVENUE);
    expect(a.peakHours.reduce((s, h) => s + h.revenue, 0)).toBe(REVENUE);
    expect(a.peakDays.reduce((s, d) => s + d.revenue, 0)).toBe(REVENUE);
    expect(a.completedOrders).toBe(2);
    expect(a.cancelledOrders).toBe(1);
  });

  it('4. customer LTV: spend per customer from paid, non-cancelled orders', async () => {
    const l = await os.getCustomerLTV(STORE);
    expect(l.totalCustomers).toBe(2); // U3 only has cancelled / failed orders
    expect(l.topCustomers.map((c) => [c.userId, c.totalSpend])).toEqual([[U2, 4800], [U1, 300]]);
  });

  it('5. monthly revenue', async () => {
    const year = new Date().getFullYear();
    const m = await os.getMonthlyRevenue(STORE, year);
    const expected = ORDERS.filter(os.isRevenue).filter((x) => x.createdAt.getUTCFullYear() === year)
      .reduce((s, x) => s + x.grandTotal, 0);
    expect(m.reduce((s, b) => s + b.revenue, 0)).toBe(expected);
  });

  it('6. staff performance: exits and manual exits count as completions', async () => {
    const p = await os.getStaffPerformance(STORE);
    const byId = Object.fromEntries(p.map((s) => [s.staffId, s.ordersCompleted]));
    expect(byId).toEqual({ s1: 2, s2: 1 });
  });
});

describe('store dashboard resolver', () => {
  it('reports the real weekly revenue instead of 0', async () => {
    jest.resetModules();
    jest.doMock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('firebase-admin', () => ({
      auth: () => ({ verifyIdToken: jest.fn() }), apps: [{}], initializeApp: jest.fn(),
      credential: { cert: jest.fn(), applicationDefault: jest.fn() }, messaging: () => ({ send: jest.fn() }),
    }));
    jest.doMock('../src/services/orderService', () => ({
      getStoreStats: jest.fn().mockResolvedValue({
        store: { name: 'S' }, totalRevenue: REVENUE, totalOrders: 6, pendingOrders: 2, completedOrders: 2,
        recentOrders: [], thisWeekRevenue: THIS_WEEK, lastWeekRevenue: LAST_WEEK,
      }),
    }));
    const { Roles } = require('../src/constants/roles');
    const resolvers = require('../src/resolvers');
    const admin = { _id: 'u-admin', roles: [Roles.ADMIN], storeId: STORE };
    const s = await resolvers.Query.dashboardStats({}, {}, { user: { uid: 'x' }, dbUser: admin });
    expect(s).toMatchObject({ thisWeekRevenue: THIS_WEEK, lastWeekRevenue: LAST_WEEK });
    expect(s.revenueGrowthRate).toBeCloseTo(((THIS_WEEK - LAST_WEEK) / LAST_WEEK) * 100);
  });
});
