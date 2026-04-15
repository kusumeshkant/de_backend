const { GraphQLError }   = require('graphql');
const StoreSubscription  = require('../models/StoreSubscription');
const SubscriptionPlan   = require('../models/SubscriptionPlan');
const { SUBSCRIPTION_STATUS, FEATURE_KEYS } = require('../constants/feature_keys');

/**
 * feature_access_service — answers "can this store use this feature?".
 *
 * Uses an in-process Map cache with a 5-minute TTL to avoid a DB hit on
 * every resolver call. Cache is invalidated when subscription_service
 * mutates a subscription document.
 *
 * Thread safety: Node.js is single-threaded, so the Map is safe without locks.
 */

// ── In-memory cache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @type {Map<string, { plan: object, sub: object, expiresAt: number }>}
 */
const _cache = new Map();

/**
 * Returns the plan+subscription pair from cache or DB.
 * @param {string} storeId  MongoDB ObjectId as string
 */
async function _getSubscriptionContext(storeId) {
  const now    = Date.now();
  const cached = _cache.get(storeId);
  if (cached && cached.expiresAt > now) return cached;

  const sub = await StoreSubscription.findOne({ storeId }).populate('planId').lean();
  if (!sub) return null;

  const entry = { sub, plan: sub.planId, expiresAt: now + CACHE_TTL_MS };
  _cache.set(storeId, entry);
  return entry;
}

/**
 * Removes a store's cache entry — call this whenever a subscription changes.
 * Exported so subscription_service can call it after any mutation.
 */
function invalidateCache(storeId) {
  _cache.delete(storeId.toString());
}

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if the subscription status grants access (not hard-locked).
 */
function _isAccessible(status) {
  return [
    SUBSCRIPTION_STATUS.TRIAL,
    SUBSCRIPTION_STATUS.ACTIVE,
    SUBSCRIPTION_STATUS.GRACE_PERIOD,
    SUBSCRIPTION_STATUS.ADMIN_OVERRIDE,
    SUBSCRIPTION_STATUS.GRANDFATHERED,
  ].includes(status);
}

/**
 * Returns true if the subscription is within a valid date window.
 * GRACE_PERIOD is valid until gracePeriodEndsAt; others until currentPeriodEnd.
 */
function _isPeriodValid(sub) {
  const now = new Date();
  if (sub.status === SUBSCRIPTION_STATUS.GRACE_PERIOD) {
    return sub.gracePeriodEndsAt ? sub.gracePeriodEndsAt > now : false;
  }
  if (sub.status === SUBSCRIPTION_STATUS.TRIAL) {
    return sub.trialEndsAt ? sub.trialEndsAt > now : false;
  }
  if (sub.status === SUBSCRIPTION_STATUS.ADMIN_OVERRIDE) {
    return sub.overrideExpiresAt ? sub.overrideExpiresAt > now : true;
  }
  if (sub.status === SUBSCRIPTION_STATUS.GRANDFATHERED) {
    return sub.currentPeriodEnd ? sub.currentPeriodEnd > now : true;
  }
  // ACTIVE or CANCELLED — access continues to currentPeriodEnd
  return sub.currentPeriodEnd ? sub.currentPeriodEnd > now : false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if the store can use the given feature.
 *
 * Access is granted when ALL of:
 *  1. A StoreSubscription record exists.
 *  2. The status is accessible (not expired/cancelled-past-period).
 *  3. The date window is valid.
 *  4. The plan's feature flag is true for this featureKey.
 *
 * @param {string} storeId
 * @param {string} featureKey  One of FEATURE_KEYS values
 * @returns {Promise<boolean>}
 */
async function canUseFeature(storeId, featureKey) {
  const ctx = await _getSubscriptionContext(storeId.toString());
  if (!ctx) return false;

  const { sub, plan } = ctx;
  if (!_isAccessible(sub.status)) return false;
  if (!_isPeriodValid(sub)) return false;
  if (!plan || !plan.features) return false;

  return plan.features[featureKey] === true;
}

/**
 * Throws FORBIDDEN if the store cannot use the feature.
 * Drop this in any resolver that gates behind a plan feature.
 *
 * @param {string} storeId
 * @param {string} featureKey  One of FEATURE_KEYS values
 * @param {string} [featureName]  Human-readable name for the error message
 */
async function assertFeatureAccess(storeId, featureKey, featureName) {
  const allowed = await canUseFeature(storeId, featureKey);
  if (!allowed) {
    const label = featureName || featureKey;
    throw new GraphQLError(
      `Your current plan does not include ${label}. Please upgrade to access this feature.`,
      {
        extensions: {
          code:       'FEATURE_GATED',
          featureKey,
          storeId:    storeId.toString(),
        },
      }
    );
  }
}

/**
 * Returns a full feature access map for a store — used by dq_admin dashboard
 * to show/hide UI elements without individual resolver calls.
 *
 * @param {string} storeId
 * @returns {Promise<Record<string, boolean>>}
 */
async function getFeatureAccessMap(storeId) {
  const ctx = await _getSubscriptionContext(storeId.toString());
  const map = {};

  for (const key of Object.values(FEATURE_KEYS)) {
    map[key] = false;
  }

  if (!ctx) return map;

  const { sub, plan } = ctx;
  const accessible    = _isAccessible(sub.status) && _isPeriodValid(sub);

  if (accessible && plan?.features) {
    for (const key of Object.values(FEATURE_KEYS)) {
      map[key] = plan.features[key] === true;
    }
  }

  return map;
}

/**
 * Returns the subscription status string for a store, or 'none' if not found.
 */
async function getSubscriptionStatus(storeId) {
  const ctx = await _getSubscriptionContext(storeId.toString());
  if (!ctx) return 'none';
  return ctx.sub.status;
}

module.exports = {
  canUseFeature,
  assertFeatureAccess,
  getFeatureAccessMap,
  getSubscriptionStatus,
  invalidateCache,
};
