/**
 * Centralised subscription constants for the DQ platform.
 *
 * SINGLE SOURCE OF TRUTH — import this file in all services, resolvers, and scripts
 * that deal with plan features or limits. Never use raw strings for feature keys.
 *
 * Adding a new feature:
 *   1. Add key to FEATURE_KEYS.
 *   2. Add the boolean field to SubscriptionPlan.features schema.
 *   3. Set the value in every plan seed record (seedSubscriptionPlans.js).
 *   4. Add the FeatureGuard check in the relevant Flutter screen.
 */

/**
 * Binary feature flags — these are the canonical keys used across
 * DB plan documents, service checks, and Flutter FeatureGuard widgets.
 * @readonly
 */
const FEATURE_KEYS = Object.freeze({
  COUPONS:                      'coupons',
  ANALYTICS:                    'analytics',
  BULK_UPLOAD:                  'bulkUpload',
  ADVANCED_REPORTS:             'advancedReports',
  STAFF_PERFORMANCE_ANALYTICS:  'staffPerformanceAnalytics',
  CUSTOMER_LTV_ANALYTICS:       'customerLtvAnalytics',
  PRIORITY_SUPPORT:             'prioritySupport',
  CUSTOM_BRANDING:              'customBranding',
  EXPORT_DATA:                  'exportData',
});

/**
 * Numeric limit keys — these are the canonical names used in
 * StoreSubscription.usageCounters and plan_limit_service checks.
 * @readonly
 */
const PLAN_LIMITS = Object.freeze({
  MAX_STAFF:              'maxStaff',
  MAX_PRODUCTS:           'maxProducts',
  MAX_ORDERS_PER_MONTH:   'maxOrdersPerMonth',
  MAX_STORES:             'maxStores',
});

/**
 * Subscription lifecycle states stored in StoreSubscription.status.
 * @readonly
 */
const SUBSCRIPTION_STATUS = Object.freeze({
  TRIAL:          'trial',
  ACTIVE:         'active',
  GRACE_PERIOD:   'grace_period',
  EXPIRED:        'expired',
  CANCELLED:      'cancelled',
  ADMIN_OVERRIDE: 'admin_override',
  GRANDFATHERED:  'grandfathered',
});

/**
 * Billing cycles — stored in StoreSubscription.billingCycle.
 * @readonly
 */
const BILLING_CYCLE = Object.freeze({
  MONTHLY: 'monthly',
  ANNUAL:  'annual',
  NONE:    'none',       // trial / grandfathered / admin override
});

/**
 * Subscription event types — stored in SubscriptionEvent.eventType (append-only log).
 * @readonly
 */
const SUBSCRIPTION_EVENT = Object.freeze({
  TRIAL_STARTED:       'trial_started',
  TRIAL_EXPIRED:       'trial_expired',
  PLAN_ACTIVATED:      'plan_activated',
  PLAN_UPGRADED:       'plan_upgraded',
  PLAN_DOWNGRADED:     'plan_downgraded',
  PLAN_RENEWED:        'plan_renewed',
  GRACE_PERIOD_ENTERED:'grace_period_entered',
  SUBSCRIPTION_EXPIRED:'subscription_expired',
  SUBSCRIPTION_CANCELLED:'subscription_cancelled',
  ADMIN_OVERRIDE_SET:  'admin_override_set',
  ADMIN_OVERRIDE_CLEARED:'admin_override_cleared',
  GRANDFATHERED:       'grandfathered',
  MIGRATED:            'migrated',
});

/**
 * Plan names — the canonical name field values in SubscriptionPlan documents.
 * @readonly
 */
const PLAN_NAMES = Object.freeze({
  FREE:          'free',
  TRIAL:         'trial',
  STARTER:       'starter',
  GROWTH:        'growth',
  PRO:           'pro',
  ENTERPRISE:    'enterprise',
  GRANDFATHERED: 'grandfathered',
});

/**
 * Sentinel value used in numeric limits to represent "unlimited".
 * Stored as -1 in MongoDB; service layer interprets < 0 as no cap.
 */
const UNLIMITED = -1;

module.exports = {
  FEATURE_KEYS,
  PLAN_LIMITS,
  SUBSCRIPTION_STATUS,
  BILLING_CYCLE,
  SUBSCRIPTION_EVENT,
  PLAN_NAMES,
  UNLIMITED,
};
