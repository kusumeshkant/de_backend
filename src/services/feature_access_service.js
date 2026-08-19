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
  if (storeId === null || storeId === undefined) return;
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

// ── Denial reasons ────────────────────────────────────────────────────────────
//
// A feature can be unavailable for four quite different reasons, and they need
// different messages. Previously every denial said "your plan does not include
// X", which is simply wrong when the plan *does* include X and the subscription
// has merely lapsed — and outright misleading for bulkUpload, which every plan
// grants, so a bulkUpload denial is *always* a subscription problem.
const DENIAL = Object.freeze({
  NO_SUBSCRIPTION: 'no_subscription', // no StoreSubscription record at all
  NO_PLAN:         'no_plan',         // subscription exists but planId did not resolve
  STATUS_LOCKED:   'status_locked',   // expired / cancelled past period
  PERIOD_LAPSED:   'period_lapsed',   // status is fine but the date window has passed
  NOT_IN_PLAN:     'not_in_plan',     // genuinely a higher-tier feature
});

/**
 * Returns null when access is allowed, or a DENIAL reason when it is not.
 * Single source of truth for both canUseFeature and assertFeatureAccess so the
 * boolean answer and the error message can never disagree.
 *
 * Caller must have already handled the null-storeId and kill-switch cases.
 */
async function _evaluateAccess(storeId, featureKey) {
  const ctx = await _getSubscriptionContext(storeId.toString());
  if (!ctx) return DENIAL.NO_SUBSCRIPTION;

  const { sub, plan } = ctx;
  if (!_isAccessible(sub.status)) return DENIAL.STATUS_LOCKED;
  if (!_isPeriodValid(sub))       return DENIAL.PERIOD_LAPSED;
  if (!plan || !plan.features)    return DENIAL.NO_PLAN;

  return plan.features[featureKey] === true ? null : DENIAL.NOT_IN_PLAN;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * True when *storeId* refers to platform-wide scope rather than one store.
 *
 * resolveStoreScope() in the resolvers returns null to mean "all stores", which
 * only a PLATFORM_ADMIN can obtain. Such a caller is not operating under any one
 * store's subscription, so per-store plan gating does not apply to them — and
 * attempting to evaluate it crashed on null.toString() (F-BUG-1).
 */
function _isPlatformScope(storeId) {
  return storeId === null || storeId === undefined;
}

/**
 * Returns true if the store can use the given feature.
 *
 * Access is granted when ALL of:
 *  1. A StoreSubscription record exists.
 *  2. The status is accessible (not expired/cancelled-past-period).
 *  3. The date window is valid.
 *  4. The plan's feature flag is true for this featureKey.
 *
 * A null/undefined storeId means platform-wide scope and is always allowed.
 *
 * @param {string|null} storeId
 * @param {string} featureKey  One of FEATURE_KEYS values
 * @returns {Promise<boolean>}
 */
async function canUseFeature(storeId, featureKey) {
  if (process.env.SUBSCRIPTION_ENABLED === 'false') return true;
  if (_isPlatformScope(storeId)) return true;

  return (await _evaluateAccess(storeId, featureKey)) === null;
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
  if (process.env.SUBSCRIPTION_ENABLED === 'false') return;

  // Platform-wide scope (PLATFORM_ADMIN reading across stores) — not bound to
  // any single store's plan, so the gate does not apply. Bypassing is correct
  // here rather than picking some arbitrary store's plan to check against.
  if (_isPlatformScope(storeId)) return;

  const reason = await _evaluateAccess(storeId, featureKey);
  if (reason === null) return;

  const label = featureName || featureKey;

  // Message must match the actual cause. A lapsed subscription is not the same
  // problem as an insufficient plan, and telling someone to upgrade a plan that
  // already includes the feature is worse than saying nothing.
  const message =
    reason === DENIAL.NOT_IN_PLAN
      ? `Your current plan does not include ${label}. Please upgrade to access this feature.`
      : reason === DENIAL.PERIOD_LAPSED || reason === DENIAL.STATUS_LOCKED
        ? `Your subscription has lapsed, so ${label} is currently unavailable. Please renew to restore access.`
        : `No active subscription was found for this store, so ${label} is unavailable. Please contact support.`;

  throw new GraphQLError(message, {
    extensions: {
      code:       'FEATURE_GATED',
      featureKey,
      // Lets a client distinguish "upgrade" from "renew" without parsing prose.
      reason,
      storeId:    storeId.toString(),
    },
  });
}

/**
 * Returns a full feature access map for a store — used by dq_admin dashboard
 * to show/hide UI elements without individual resolver calls.
 *
 * @param {string} storeId
 * @returns {Promise<Record<string, boolean>>}
 */
async function getFeatureAccessMap(storeId) {
  const map = {};
  for (const key of Object.values(FEATURE_KEYS)) {
    map[key] = false;
  }

  // Kill switch, or platform-wide scope — everything unlocked either way.
  if (process.env.SUBSCRIPTION_ENABLED === 'false' || _isPlatformScope(storeId)) {
    for (const key of Object.values(FEATURE_KEYS)) map[key] = true;
    return map;
  }

  const ctx = await _getSubscriptionContext(storeId.toString());
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
  if (_isPlatformScope(storeId)) return 'none';
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
