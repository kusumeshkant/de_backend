const { GraphQLError }   = require('graphql');
const StoreSubscription  = require('../models/StoreSubscription');
const SubscriptionPlan   = require('../models/SubscriptionPlan');
const Product            = require('../models/Product');
const User               = require('../models/User');
const Order              = require('../models/Order');
const { SUBSCRIPTION_STATUS, PLAN_LIMITS, UNLIMITED } = require('../constants/feature_keys');
const { invalidateCache } = require('./feature_access_service');

/**
 * plan_limit_service — enforces numeric limits defined per plan.
 *
 * Three public entry points:
 *  - assertLimitNotReached(storeId, limitKey)  → throws if at/over cap
 *  - getRemainingUsage(storeId, limitKey)       → returns { used, limit, remaining }
 *  - refreshUsageCounters(storeId)              → syncs DB counts → StoreSubscription.usageCounters
 *
 * Usage counters in StoreSubscription are a cache of the real DB counts.
 * refreshUsageCounters() is called after mutations that affect those counts.
 * assertLimitNotReached() reads live DB counts (not the cache) to be safe.
 */

// ── Live count helpers ────────────────────────────────────────────────────────

async function _liveStaffCount(storeId) {
  const { Roles } = require('../constants/roles');
  return User.countDocuments({ storeId, roles: Roles.STAFF });
}

async function _liveProductCount(storeId) {
  return Product.countDocuments({ storeId, isAvailable: { $ne: false } });
}

async function _liveOrdersThisMonth(storeId) {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return Order.countDocuments({ storeId, createdAt: { $gte: start } });
}

const _liveCounters = {
  [PLAN_LIMITS.MAX_STAFF]:            _liveStaffCount,
  [PLAN_LIMITS.MAX_PRODUCTS]:         _liveProductCount,
  [PLAN_LIMITS.MAX_ORDERS_PER_MONTH]: _liveOrdersThisMonth,
  [PLAN_LIMITS.MAX_STORES]:           async () => 1, // single-store per sub for now
};

// ── Subscription / plan fetch ─────────────────────────────────────────────────

async function _getSubAndPlan(storeId) {
  const sub = await StoreSubscription.findOne({ storeId }).populate('planId');
  if (!sub) return { sub: null, plan: null };
  return { sub, plan: sub.planId };
}

// ── Status check ──────────────────────────────────────────────────────────────

function _isAccessible(status) {
  return [
    SUBSCRIPTION_STATUS.TRIAL,
    SUBSCRIPTION_STATUS.ACTIVE,
    SUBSCRIPTION_STATUS.GRACE_PERIOD,
    SUBSCRIPTION_STATUS.ADMIN_OVERRIDE,
    SUBSCRIPTION_STATUS.GRANDFATHERED,
  ].includes(status);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Throws LIMIT_REACHED if the store is at or over its plan cap for limitKey.
 * Uses live DB counts — not cached counters — to prevent race conditions.
 *
 * @param {string} storeId
 * @param {string} limitKey  One of PLAN_LIMITS values
 * @param {number} [addCount=1]  How many new items will be added (for batch ops)
 */
async function assertLimitNotReached(storeId, limitKey, addCount = 1) {
  if (process.env.SUBSCRIPTION_ENABLED === 'false') return; // Kill switch
  const { sub, plan } = await _getSubAndPlan(storeId);
  if (!sub || !plan) return; // No subscription → no cap (new store edge case)
  if (!_isAccessible(sub.status)) return; // Already expired — other guards handle this

  const cap = plan.limits?.[limitKey];
  if (cap === undefined || cap === null) return; // Limit not defined for this key
  if (cap === UNLIMITED || cap < 0) return;      // Unlimited plan

  const liveCount = _liveCounters[limitKey];
  if (!liveCount) return;

  const current = await liveCount(storeId);
  if (current + addCount > cap) {
    const friendlyNames = {
      [PLAN_LIMITS.MAX_STAFF]:            'staff members',
      [PLAN_LIMITS.MAX_PRODUCTS]:         'products',
      [PLAN_LIMITS.MAX_ORDERS_PER_MONTH]: 'orders this month',
      [PLAN_LIMITS.MAX_STORES]:           'stores',
    };
    const label = friendlyNames[limitKey] || limitKey;
    throw new GraphQLError(
      `You have reached the ${label} limit (${cap}) on your current plan. Please upgrade to add more.`,
      {
        extensions: {
          code:      'LIMIT_REACHED',
          limitKey,
          current,
          cap,
          storeId:   storeId.toString(),
        },
      }
    );
  }
}

/**
 * Returns usage + cap info for a given limit key.
 * Safe to call from resolvers to show progress bars in UI.
 *
 * @param {string} storeId
 * @param {string} limitKey  One of PLAN_LIMITS values
 * @returns {Promise<{ used: number, limit: number, remaining: number, isUnlimited: boolean }>}
 */
async function getRemainingUsage(storeId, limitKey) {
  const { sub, plan } = await _getSubAndPlan(storeId);
  const liveCount = _liveCounters[limitKey];
  const used = liveCount ? await liveCount(storeId) : 0;

  if (!plan) return { used, limit: 0, remaining: 0, isUnlimited: false };

  const cap = plan.limits?.[limitKey];
  if (cap === UNLIMITED || cap < 0) return { used, limit: UNLIMITED, remaining: UNLIMITED, isUnlimited: true };

  return {
    used,
    limit:      cap,
    remaining:  Math.max(0, cap - used),
    isUnlimited: false,
  };
}

/**
 * Syncs live DB counts into StoreSubscription.usageCounters.
 * Call after createProduct, deleteProduct, inviteStaff, removeStaff, createOrder.
 *
 * @param {string} storeId
 */
async function refreshUsageCounters(storeId) {
  const [staffCount, productCount, ordersThisMonth] = await Promise.all([
    _liveStaffCount(storeId),
    _liveProductCount(storeId),
    _liveOrdersThisMonth(storeId),
  ]);

  await StoreSubscription.findOneAndUpdate(
    { storeId },
    {
      'usageCounters.staffCount':      staffCount,
      'usageCounters.productCount':    productCount,
      'usageCounters.ordersThisMonth': ordersThisMonth,
      'usageCounters.lastCountedAt':   new Date(),
    }
  );

  invalidateCache(storeId.toString());
}

module.exports = {
  assertLimitNotReached,
  getRemainingUsage,
  refreshUsageCounters,
};
