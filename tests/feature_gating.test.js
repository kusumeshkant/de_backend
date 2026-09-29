/**
 * feature_access_service.assertFeatureAccess + plan_limit_service.assertLimitNotReached
 * unit tests — the server-side enforcement this audit found was missing.
 * No database connection required.
 */

const mockSubFindOne = jest.fn();

jest.mock('../src/models/StoreSubscription', () => ({
  findOne: mockSubFindOne,
}));
jest.mock('../src/models/SubscriptionPlan', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/models/Order', () => ({ countDocuments: jest.fn() }));

describe('assertFeatureAccess — Starter plan without coupons', () => {
  const OLD_ENV = process.env.SUBSCRIPTION_ENABLED;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.SUBSCRIPTION_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.SUBSCRIPTION_ENABLED = OLD_ENV;
  });

  it('blocks generateDiscountCode-style access when plan.features.coupons is false', async () => {
    mockSubFindOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          status: 'active',
          currentPeriodEnd: new Date(Date.now() + 86400000),
          planId: { features: { coupons: false } },
        }),
      }),
    });

    const { assertFeatureAccess } = require('../src/services/feature_access_service');

    await expect(assertFeatureAccess('store-1', 'coupons', 'Coupons & Discounts'))
      .rejects.toThrow('Your current plan does not include Coupons & Discounts');
  });

  it('allows access when plan.features.coupons is true (Growth/Enterprise)', async () => {
    mockSubFindOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          status: 'active',
          currentPeriodEnd: new Date(Date.now() + 86400000),
          planId: { features: { coupons: true } },
        }),
      }),
    });

    const { assertFeatureAccess } = require('../src/services/feature_access_service');

    await expect(assertFeatureAccess('store-1', 'coupons', 'Coupons & Discounts')).resolves.toBeUndefined();
  });

  it('is a no-op when SUBSCRIPTION_ENABLED is "false" (kill switch)', async () => {
    process.env.SUBSCRIPTION_ENABLED = 'false';
    const { assertFeatureAccess } = require('../src/services/feature_access_service');

    await expect(assertFeatureAccess('store-1', 'coupons', 'Coupons & Discounts')).resolves.toBeUndefined();
    expect(mockSubFindOne).not.toHaveBeenCalled();
  });

  it('blocks when the subscription period has lapsed even if the feature flag is true', async () => {
    mockSubFindOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          status: 'active',
          currentPeriodEnd: new Date(Date.now() - 86400000), // yesterday
          planId: { features: { coupons: true } },
        }),
      }),
    });

    const { assertFeatureAccess } = require('../src/services/feature_access_service');

    // The plan DOES include coupons — the subscription lapsed. Telling this
    // user to upgrade would be wrong, so the message must say "renew".
    await expect(assertFeatureAccess('store-1', 'coupons', 'Coupons & Discounts'))
      .rejects.toThrow('Your subscription has lapsed');
  });
});

// ── F-BUG-1 ───────────────────────────────────────────────────────────────────
describe('assertFeatureAccess — platform-wide scope (null storeId)', () => {
  const OLD_ENV = process.env.SUBSCRIPTION_ENABLED;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.SUBSCRIPTION_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.SUBSCRIPTION_ENABLED = OLD_ENV;
  });

  // resolveStoreScope() returns null for a PLATFORM_ADMIN reading across every
  // store. Before this fix, assertFeatureAccess did storeId.toString() on it and
  // threw TypeError: Cannot read properties of null (reading 'toString'),
  // surfacing as a 500 on customerLTV and staffPerformance.
  it('resolves without throwing for a null storeId', async () => {
    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await expect(assertFeatureAccess(null, 'customerLtvAnalytics', 'Customer LTV Analytics'))
      .resolves.toBeUndefined();
  });

  it('resolves without throwing for an undefined storeId', async () => {
    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await expect(assertFeatureAccess(undefined, 'staffPerformanceAnalytics', 'Staff Performance Analytics'))
      .resolves.toBeUndefined();
  });

  it('does not hit the database at all for platform scope', async () => {
    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await assertFeatureAccess(null, 'coupons', 'Coupons & Discounts');
    expect(mockSubFindOne).not.toHaveBeenCalled();
  });

  it('canUseFeature returns true for platform scope', async () => {
    const { canUseFeature } = require('../src/services/feature_access_service');
    await expect(canUseFeature(null, 'customerLtvAnalytics')).resolves.toBe(true);
  });

  it('getFeatureAccessMap unlocks everything for platform scope', async () => {
    const { getFeatureAccessMap } = require('../src/services/feature_access_service');
    const map = await getFeatureAccessMap(null);
    expect(Object.values(map).every((v) => v === true)).toBe(true);
    expect(mockSubFindOne).not.toHaveBeenCalled();
  });

  it('still gates a real storeId — the bypass is scoped to null only', async () => {
    mockSubFindOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          status: 'active',
          currentPeriodEnd: new Date(Date.now() + 86400000),
          planId: { features: { customerLtvAnalytics: false } },
        }),
      }),
    });

    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await expect(assertFeatureAccess('store-1', 'customerLtvAnalytics', 'Customer LTV Analytics'))
      .rejects.toThrow('Your current plan does not include Customer LTV Analytics');
  });
});

// ── Denial-message accuracy ───────────────────────────────────────────────────
describe('assertFeatureAccess — denial reason matches the actual cause', () => {
  const OLD_ENV = process.env.SUBSCRIPTION_ENABLED;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.SUBSCRIPTION_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.SUBSCRIPTION_ENABLED = OLD_ENV;
  });

  function mockSub(doc) {
    mockSubFindOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
    });
  }

  it('bulkUpload denial says "renew", not "upgrade" — every plan includes bulkUpload', async () => {
    // Starter/Growth/Enterprise/Trial/Grandfathered all set bulkUpload: true,
    // so a bulkUpload denial is ALWAYS a subscription problem, never a tier one.
    mockSub({
      status: 'active',
      currentPeriodEnd: new Date(Date.now() - 86400000),
      planId: { features: { bulkUpload: true } },
    });

    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await expect(assertFeatureAccess('store-1', 'bulkUpload', 'Bulk Upload'))
      .rejects.toThrow('Your subscription has lapsed');
  });

  it('reports "no active subscription" when no record exists', async () => {
    mockSub(null);
    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await expect(assertFeatureAccess('store-1', 'bulkUpload', 'Bulk Upload'))
      .rejects.toThrow('No active subscription was found for this store');
  });

  it('reports "upgrade" only when the plan genuinely lacks the feature', async () => {
    mockSub({
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 86400000),
      planId: { features: { coupons: false } },
    });
    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    await expect(assertFeatureAccess('store-1', 'coupons', 'Coupons & Discounts'))
      .rejects.toThrow('Please upgrade to access this feature');
  });

  it('exposes a machine-readable reason in extensions', async () => {
    mockSub({
      status: 'active',
      currentPeriodEnd: new Date(Date.now() - 86400000),
      planId: { features: { coupons: true } },
    });
    const { assertFeatureAccess } = require('../src/services/feature_access_service');
    try {
      await assertFeatureAccess('store-1', 'coupons', 'Coupons & Discounts');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.extensions.code).toBe('FEATURE_GATED');
      expect(err.extensions.reason).toBe('period_lapsed');
      expect(err.extensions.featureKey).toBe('coupons');
    }
  });
});

describe('assertLimitNotReached — order cap checked pre-payment', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.SUBSCRIPTION_ENABLED = 'true';
  });

  it('throws LIMIT_REACHED when live order count is already at the plan cap', async () => {
    const mockSub = {
      status: 'active',
      planId: { limits: { maxOrdersPerMonth: 500 } },
    };
    mockSubFindOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(mockSub) });
    const Order = require('../src/models/Order');
    Order.countDocuments.mockResolvedValue(500);

    const { assertLimitNotReached } = require('../src/services/plan_limit_service');

    await expect(assertLimitNotReached('store-1', 'maxOrdersPerMonth'))
      .rejects.toThrow('You have reached the orders this month limit (500)');
  });

  it('allows order creation when under the cap', async () => {
    const mockSub = {
      status: 'active',
      planId: { limits: { maxOrdersPerMonth: 500 } },
    };
    mockSubFindOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(mockSub) });
    const Order = require('../src/models/Order');
    Order.countDocuments.mockResolvedValue(10);

    const { assertLimitNotReached } = require('../src/services/plan_limit_service');

    await expect(assertLimitNotReached('store-1', 'maxOrdersPerMonth')).resolves.toBeUndefined();
  });

  it('honors addCount for bulk staff invites — blocks when the batch would exceed the cap', async () => {
    const mockSub = {
      status: 'active',
      planId: { limits: { maxStaff: 3 } },
    };
    mockSubFindOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(mockSub) });
    const User = require('../src/models/User');
    User.countDocuments.mockResolvedValue(2); // 2 existing staff

    const { assertLimitNotReached } = require('../src/services/plan_limit_service');

    // Inviting 2 more would make 4, over the cap of 3
    await expect(assertLimitNotReached('store-1', 'maxStaff', 2)).rejects.toThrow('You have reached the staff members limit (3)');
    // Inviting 1 more (total 3) is exactly at cap — allowed
    await expect(assertLimitNotReached('store-1', 'maxStaff', 1)).resolves.toBeUndefined();
  });
});
