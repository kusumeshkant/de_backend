/**
 * createOrder resolver — signature first, server values only (A3; 07 §5 priority 2).
 *
 * Exercises the REAL resolver and the REAL verifyPayment (HMAC-SHA256 over
 * "orderId|paymentId" with the key secret). The order services are mocked so
 * each denial can assert the service was NEVER called — a check that runs too
 * late would still pass a test that only looks at the thrown error.
 */
const crypto = require('crypto');

const SECRET = 'test_secret_for_unit_tests';
process.env.RAZORPAY_KEY_SECRET = SECRET;
const sign = (orderId, paymentId) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

jest.mock('../src/utils/logger_cf', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: jest.fn() }), apps: [{}], initializeApp: jest.fn(),
  credential: { cert: jest.fn(), applicationDefault: jest.fn() }, messaging: () => ({ send: jest.fn() }),
}));
jest.mock('../src/services/orderService', () => ({
  createOrder: jest.fn(), findOrderForPayment: jest.fn(), getPendingForUser: jest.fn(),
  getMyOrders: jest.fn(), getOrderById: jest.fn(), getStoreOrders: jest.fn(), getOrderByIdForStaff: jest.fn(),
  updateOrderStatus: jest.fn(), flagOrderIssue: jest.fn(), getAllOrders: jest.fn(), getOrdersPaginated: jest.fn(),
  getDashboardStats: jest.fn(), getStoreStats: jest.fn(), validateCartStock: jest.fn(), getStoreAnalytics: jest.fn(),
  getCustomerRetention: jest.fn(), getStaffPerformance: jest.fn(), getBasketAbandonmentStats: jest.fn(),
  getCustomerLTV: jest.fn(), getMonthlyRevenue: jest.fn(),
}));
jest.mock('../src/services/discountService', () => ({
  validateDiscountCode: jest.fn(), consumeDiscountCode: jest.fn().mockResolvedValue(null),
  generateDiscountCode: jest.fn(), getDiscountLogs: jest.fn(), getActiveCodesForStaff: jest.fn(),
}));
jest.mock('../src/services/plan_limit_service', () => ({
  assertLimitNotReached: jest.fn().mockResolvedValue(), getRemainingUsage: jest.fn(), refreshUsageCounters: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/notificationService_cf', () => ({
  sendOrderConfirmation: jest.fn().mockResolvedValue(), sendOrderStatusUpdate: jest.fn().mockResolvedValue(),
  sendNewOrderToStaff: jest.fn().mockResolvedValue(), sendPermissionRequestNotification: jest.fn().mockResolvedValue(),
  sendPermissionStatusNotification: jest.fn().mockResolvedValue(),
}));

const { Roles } = require('../src/constants/roles');
const orderService = require('../src/services/orderService');
const discountService = require('../src/services/discountService');
const planLimits = require('../src/services/plan_limit_service');
const notifications = require('../src/services/notificationService_cf');
const resolvers = require('../src/resolvers');

const STORE_PAID = 'store-paid-for';
const ctx = () => ({
  user: { uid: 'uid-c', email: 'c@example.com', phone: null },
  dbUser: { _id: 'user-c', firebase_uid: 'uid-c', roles: [Roles.CUSTOMER], storeId: null, fcmToken: 't' },
});
const ORDER = {
  _id: 'order-1', storeId: STORE_PAID, grandTotal: 528.88, total: 448.2, tax: 80.68, discountAmount: 49.8,
  items: [{ barcode: 'RICE' }], _storeName: 'S', _discountCode: 'SAVE10', _subtotal: 498,
};
const call = (args) => resolvers.Mutation.createOrder({}, args, ctx());
const signed = (orderId = 'rzp_A', paymentId = 'pay_A', extra = {}) => ({
  razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sign(orderId, paymentId), ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  orderService.findOrderForPayment.mockResolvedValue(null);
  orderService.getPendingForUser.mockResolvedValue({ storeId: STORE_PAID });
  orderService.createOrder.mockResolvedValue({ ...ORDER });
});

describe('signature verification happens before anything else', () => {
  it('a valid signature creates the order', async () => {
    await expect(call(signed())).resolves.toEqual(expect.objectContaining({ _id: 'order-1' }));
    expect(orderService.createOrder).toHaveBeenCalledTimes(1);
  });

  it('an invalid signature is refused and nothing is looked up or written', async () => {
    await expect(call({ ...signed(), razorpaySignature: 'f'.repeat(64) }))
      .rejects.toMatchObject({ extensions: { code: 'PAYMENT_VERIFICATION_FAILED' } });
    expect(orderService.findOrderForPayment).not.toHaveBeenCalled();
    expect(orderService.getPendingForUser).not.toHaveBeenCalled();
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(discountService.consumeDiscountCode).not.toHaveBeenCalled();
  });

  it("order A's signature cannot be used for order B (mismatched order)", async () => {
    const forA = signed('rzp_A', 'pay_A');
    await expect(call({ ...forA, razorpayOrderId: 'rzp_B' }))
      .rejects.toMatchObject({ extensions: { code: 'PAYMENT_VERIFICATION_FAILED' } });
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('a signature for a different payment id is refused', async () => {
    const forA = signed('rzp_A', 'pay_A');
    await expect(call({ ...forA, razorpayPaymentId: 'pay_OTHER' }))
      .rejects.toMatchObject({ extensions: { code: 'PAYMENT_VERIFICATION_FAILED' } });
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });
});

describe('verifyPayment — constant-time comparison, never throws', () => {
  const { verifyPayment } = require('../src/services/razorpayService');
  const crypto = require('crypto');

  it('accepts the valid signature', () => {
    expect(verifyPayment('rzp_A', 'pay_A', sign('rzp_A', 'pay_A'))).toBe(true);
  });

  it('rejects an invalid signature of the correct length', () => {
    const good = sign('rzp_A', 'pay_A');
    const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    expect(verifyPayment('rzp_A', 'pay_A', flipped)).toBe(false);
  });

  it.each([
    ['too short', (s) => s.slice(0, 10)],
    ['too long', (s) => s + '00'],
    ['empty', () => ''],
    ['multi-byte characters (byte length differs)', (s) => 'é'.repeat(s.length)],
  ])('rejects a %s signature without throwing', (_label, mutate) => {
    expect(() => verifyPayment('rzp_A', 'pay_A', mutate(sign('rzp_A', 'pay_A')))).not.toThrow();
    expect(verifyPayment('rzp_A', 'pay_A', mutate(sign('rzp_A', 'pay_A')))).toBe(false);
  });

  it.each([[undefined], [null], [12345], [{}]])('rejects a non-string signature %p without throwing', (bad) => {
    expect(verifyPayment('rzp_A', 'pay_A', bad)).toBe(false);
  });

  it('uses crypto.timingSafeEqual for the comparison', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    verifyPayment('rzp_A', 'pay_A', sign('rzp_A', 'pay_A'));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a wrong-length signature through the resolver is refused, not a 500', async () => {
    await expect(call({ ...signed(), razorpaySignature: 'short' }))
      .rejects.toMatchObject({ extensions: { code: 'PAYMENT_VERIFICATION_FAILED' } });
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });
});

describe('server values only', () => {
  it('passes ONLY the Razorpay ids to the service — client items/totals/store never reach it', async () => {
    await call(signed('rzp_A', 'pay_A', {
      storeId: 'store-attacker', items: [{ barcode: 'X', name: 'x', price: 1, quantity: 1 }],
      total: 1, tax: 0, grandTotal: 1, discountCode: 'STOLEN',
    }));
    expect(orderService.createOrder).toHaveBeenCalledWith({
      userId: 'user-c', razorpayOrderId: 'rzp_A', razorpayPaymentId: 'pay_A', razorpaySignature: sign('rzp_A', 'pay_A'),
    });
  });

  it('the monthly cap is checked against the store the payment was for, not the client storeId', async () => {
    await call(signed('rzp_A', 'pay_A', { storeId: 'store-attacker' }));
    expect(planLimits.assertLimitNotReached).toHaveBeenCalledWith(STORE_PAID, expect.anything());
    expect(planLimits.assertLimitNotReached).not.toHaveBeenCalledWith('store-attacker', expect.anything());
  });

  it("consumes the pending payment's discount code — never the one the client names", async () => {
    await call(signed('rzp_A', 'pay_A', { discountCode: 'STOLEN' }));
    expect(discountService.consumeDiscountCode).toHaveBeenCalledTimes(1);
    expect(discountService.consumeDiscountCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SAVE10', storeId: STORE_PAID, originalAmount: 498, discountAmount: 49.8,
    }));
  });

  it('consumes no discount when the payment had none, even if the client sends a code', async () => {
    orderService.createOrder.mockResolvedValue({ ...ORDER, _discountCode: null });
    await call(signed('rzp_A', 'pay_A', { discountCode: 'STOLEN' }));
    expect(discountService.consumeDiscountCode).not.toHaveBeenCalled();
  });
});

describe('replay / duplicate createOrder', () => {
  it('a replayed, already-fulfilled payment returns the existing order with no side effects', async () => {
    orderService.findOrderForPayment.mockResolvedValue({ ...ORDER });
    const result = await call(signed());
    expect(result._id).toBe('order-1');
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(discountService.consumeDiscountCode).not.toHaveBeenCalled();
    expect(notifications.sendOrderConfirmation).not.toHaveBeenCalled();
    expect(notifications.sendNewOrderToStaff).not.toHaveBeenCalled();
    expect(planLimits.assertLimitNotReached).not.toHaveBeenCalled();
  });

  it('a non-customer cannot create an order even with a valid signature', async () => {
    const staffCtx = ctx();
    staffCtx.dbUser.roles = [Roles.STAFF];
    await expect(resolvers.Mutation.createOrder({}, signed(), staffCtx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });
});
