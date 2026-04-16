const { GraphQLError } = require('graphql');
const SubscriptionPlan   = require('../models/SubscriptionPlan');
const StoreSubscription  = require('../models/StoreSubscription');
const SubscriptionEvent  = require('../models/SubscriptionEvent');
const {
  SUBSCRIPTION_STATUS,
  BILLING_CYCLE,
  SUBSCRIPTION_EVENT,
  PLAN_NAMES,
  UNLIMITED,
} = require('../constants/feature_keys');
const { invalidateCache } = require('./feature_access_service');

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

async function _getPlanByName(name) {
  const plan = await SubscriptionPlan.findOne({ name, isActive: true });
  if (!plan) throw new GraphQLError(`Plan '${name}' not found`, { extensions: { code: 'NOT_FOUND' } });
  return plan;
}

async function _logEvent(storeId, eventType, { fromPlanId, toPlanId, triggeredBy = 'system', triggeredByRole, paymentId, metadata = {} } = {}) {
  await SubscriptionEvent.create({
    storeId,
    eventType,
    fromPlanId,
    toPlanId,
    triggeredBy,
    triggeredByRole,
    paymentId,
    metadata,
  });
}

// ── Core subscription operations ──────────────────────────────────────────────

/**
 * Called by createStore — gives every new store a trial period.
 * Idempotent: if a subscription already exists, returns it unchanged.
 */
async function startTrial(storeId, triggeredBy = 'system') {
  const existing = await StoreSubscription.findOne({ storeId });
  if (existing) return existing;

  const trialPlan = await _getPlanByName(PLAN_NAMES.TRIAL);
  const now        = new Date();
  const trialDays  = trialPlan.trialDays || 14;
  const trialEndsAt = addDays(now, trialDays);

  const sub = await StoreSubscription.create({
    storeId,
    planId:              trialPlan._id,
    status:              SUBSCRIPTION_STATUS.TRIAL,
    billingCycle:        BILLING_CYCLE.NONE,
    currentPeriodStart:  now,
    currentPeriodEnd:    trialEndsAt,
    trialEndsAt,
  });

  await _logEvent(storeId, SUBSCRIPTION_EVENT.TRIAL_STARTED, {
    toPlanId: trialPlan._id,
    triggeredBy,
    metadata:  { trialDays },
  });

  return sub;
}

/**
 * Activates a paid plan for a store after successful payment.
 */
async function activatePlan(storeId, { planName, billingCycle = BILLING_CYCLE.MONTHLY, paymentId, triggeredBy = 'system', triggeredByRole }) {
  const plan = await _getPlanByName(planName);
  const sub  = await StoreSubscription.findOne({ storeId });
  if (!sub) throw new GraphQLError('No subscription record found for this store', { extensions: { code: 'NOT_FOUND' } });

  const now   = new Date();
  const fromPlanId = sub.planId;
  const periodEnd  = billingCycle === BILLING_CYCLE.ANNUAL ? addYears(now, 1) : addMonths(now, 1);

  sub.planId              = plan._id;
  sub.status              = SUBSCRIPTION_STATUS.ACTIVE;
  sub.billingCycle        = billingCycle;
  sub.currentPeriodStart  = now;
  sub.currentPeriodEnd    = periodEnd;
  sub.nextBillingAt       = periodEnd;
  sub.gracePeriodEndsAt   = undefined;
  sub.isAdminOverride     = false;
  sub.overrideReason      = undefined;
  sub.overrideBy          = undefined;
  sub.overrideExpiresAt   = undefined;
  sub.lastPaymentId       = paymentId;
  sub.lastPaymentAt       = now;
  await sub.save();

  const prevPlanName = fromPlanId ? (await SubscriptionPlan.findById(fromPlanId))?.name : null;
  const eventType = prevPlanName && plan.displayOrder > (await SubscriptionPlan.findById(fromPlanId))?.displayOrder
    ? SUBSCRIPTION_EVENT.PLAN_UPGRADED
    : prevPlanName
      ? SUBSCRIPTION_EVENT.PLAN_DOWNGRADED
      : SUBSCRIPTION_EVENT.PLAN_ACTIVATED;

  await _logEvent(storeId, eventType, { fromPlanId, toPlanId: plan._id, triggeredBy, triggeredByRole, paymentId });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Renews an existing active subscription for another billing period.
 */
async function renewPlan(storeId, { paymentId, triggeredBy = 'system' }) {
  const sub = await StoreSubscription.findOne({ storeId });
  if (!sub) throw new GraphQLError('No subscription record found', { extensions: { code: 'NOT_FOUND' } });

  const now       = new Date();
  const baseDate  = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const periodEnd = sub.billingCycle === BILLING_CYCLE.ANNUAL ? addYears(baseDate, 1) : addMonths(baseDate, 1);

  sub.status             = SUBSCRIPTION_STATUS.ACTIVE;
  sub.currentPeriodStart = now;
  sub.currentPeriodEnd   = periodEnd;
  sub.nextBillingAt      = periodEnd;
  sub.gracePeriodEndsAt  = undefined;
  sub.lastPaymentId      = paymentId;
  sub.lastPaymentAt      = now;
  await sub.save();

  await _logEvent(storeId, SUBSCRIPTION_EVENT.PLAN_RENEWED, { toPlanId: sub.planId, triggeredBy, paymentId });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Cancels a subscription. Access continues until currentPeriodEnd.
 */
async function cancelSubscription(storeId, { cancelReason, triggeredBy, triggeredByRole }) {
  const sub = await StoreSubscription.findOne({ storeId });
  if (!sub) throw new GraphQLError('No subscription record found', { extensions: { code: 'NOT_FOUND' } });

  sub.status       = SUBSCRIPTION_STATUS.CANCELLED;
  sub.cancelledAt  = new Date();
  sub.cancelReason = cancelReason;
  sub.autoRenew    = false;
  await sub.save();

  await _logEvent(storeId, SUBSCRIPTION_EVENT.SUBSCRIPTION_CANCELLED, {
    fromPlanId: sub.planId, triggeredBy, triggeredByRole, metadata: { cancelReason },
  });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Enters grace period when payment fails or period expires without renewal.
 * Called by the expiry sweep job.
 */
async function enterGracePeriod(storeId) {
  const sub = await StoreSubscription.findOne({ storeId });
  if (!sub) return null;

  const plan = await SubscriptionPlan.findById(sub.planId);
  const graceDays = plan?.graceDays ?? 7;
  sub.status            = SUBSCRIPTION_STATUS.GRACE_PERIOD;
  sub.gracePeriodEndsAt = addDays(new Date(), graceDays);
  await sub.save();

  await _logEvent(storeId, SUBSCRIPTION_EVENT.GRACE_PERIOD_ENTERED, { fromPlanId: sub.planId, metadata: { graceDays } });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Expires a subscription after grace period passes. Access is hard-locked.
 * Called by the expiry sweep job.
 */
async function expireSubscription(storeId) {
  const sub = await StoreSubscription.findOne({ storeId });
  if (!sub) return null;

  sub.status = SUBSCRIPTION_STATUS.EXPIRED;
  await sub.save();

  await _logEvent(storeId, SUBSCRIPTION_EVENT.SUBSCRIPTION_EXPIRED, { fromPlanId: sub.planId });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Sets an admin override — gives a store full access for N days regardless of plan.
 */
async function setAdminOverride(storeId, { planName, days, overrideReason, triggeredBy, triggeredByRole }) {
  const plan = await _getPlanByName(planName);
  const sub  = await StoreSubscription.findOne({ storeId });
  if (!sub) throw new GraphQLError('No subscription record found', { extensions: { code: 'NOT_FOUND' } });

  sub.planId            = plan._id;
  sub.status            = SUBSCRIPTION_STATUS.ADMIN_OVERRIDE;
  sub.isAdminOverride   = true;
  sub.overrideReason    = overrideReason;
  sub.overrideBy        = triggeredBy;
  sub.overrideExpiresAt = addDays(new Date(), days);
  await sub.save();

  await _logEvent(storeId, SUBSCRIPTION_EVENT.ADMIN_OVERRIDE_SET, {
    toPlanId: plan._id, triggeredBy, triggeredByRole, metadata: { days, overrideReason },
  });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Assigns the grandfathered plan to a store (existing stores, one-time migration).
 */
async function setGrandfathered(storeId, { triggeredBy = 'system', triggeredByRole } = {}) {
  const plan = await _getPlanByName(PLAN_NAMES.GRANDFATHERED);
  let sub = await StoreSubscription.findOne({ storeId });
  const fromPlanId = sub?.planId;

  const now = new Date();
  const periodEnd = addDays(now, 90); // 90-day free window

  if (sub) {
    sub.planId             = plan._id;
    sub.status             = SUBSCRIPTION_STATUS.GRANDFATHERED;
    sub.billingCycle       = BILLING_CYCLE.NONE;
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd   = periodEnd;
    sub.isAdminOverride    = false;
    await sub.save();
  } else {
    sub = await StoreSubscription.create({
      storeId,
      planId:             plan._id,
      status:             SUBSCRIPTION_STATUS.GRANDFATHERED,
      billingCycle:       BILLING_CYCLE.NONE,
      currentPeriodStart: now,
      currentPeriodEnd:   periodEnd,
    });
  }

  await _logEvent(storeId, SUBSCRIPTION_EVENT.GRANDFATHERED, {
    fromPlanId, toPlanId: plan._id, triggeredBy, triggeredByRole,
  });
  invalidateCache(storeId.toString());
  return sub;
}

/**
 * Returns the current subscription + plan for a store.
 * Throws NOT_FOUND if no subscription exists.
 */
async function getStoreSubscription(storeId) {
  const sub = await StoreSubscription.findOne({ storeId }).populate('planId');
  if (!sub) return null;
  return sub;
}

/**
 * Returns all active plan documents visible in the pricing page.
 */
async function getAvailablePlans() {
  return SubscriptionPlan.find({ isActive: true, isVisible: true }).sort({ displayOrder: 1 });
}

module.exports = {
  startTrial,
  activatePlan,
  renewPlan,
  cancelSubscription,
  enterGracePeriod,
  expireSubscription,
  setAdminOverride,
  setGrandfathered,
  getStoreSubscription,
  getAvailablePlans,
};
