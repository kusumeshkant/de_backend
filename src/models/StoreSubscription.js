const mongoose = require('mongoose');
const { SUBSCRIPTION_STATUS, BILLING_CYCLE } = require('../constants/feature_keys');

/**
 * StoreSubscription — one document per store, tracks the active plan + lifecycle.
 *
 * Design decisions:
 *  - One document per store (storeId is unique). No history here — see SubscriptionEvent.
 *  - usageCounters are refreshed by plan_limit_service on every relevant mutation.
 *  - isAdminOverride = true lets CS manually grant full access for N days.
 *  - Grace period (gracePeriodEndsAt) is entered automatically when period expires
 *    before a renewal is confirmed. Store keeps access during grace.
 */
const storeSubscriptionSchema = new mongoose.Schema(
  {
    // ── Core relationship ─────────────────────────────────────────────────────
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      unique: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubscriptionPlan',
      required: true,
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    status: {
      type: String,
      required: true,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.TRIAL,
    },
    billingCycle: {
      type: String,
      enum: Object.values(BILLING_CYCLE),
      default: BILLING_CYCLE.NONE,
    },

    // ── Period tracking ───────────────────────────────────────────────────────
    currentPeriodStart:  { type: Date },
    currentPeriodEnd:    { type: Date },
    trialEndsAt:         { type: Date },
    gracePeriodEndsAt:   { type: Date },
    nextBillingAt:       { type: Date },

    // ── Cancellation ──────────────────────────────────────────────────────────
    cancelledAt:   { type: Date },
    cancelReason:  { type: String },
    autoRenew:     { type: Boolean, default: true },

    // ── Payment refs (Razorpay) ───────────────────────────────────────────────
    razorpaySubscriptionId: { type: String },
    razorpayCustomerId:     { type: String },
    lastPaymentId:          { type: String },
    lastPaymentAt:          { type: Date },

    // ── Admin override ────────────────────────────────────────────────────────
    isAdminOverride:    { type: Boolean, default: false },
    overrideReason:     { type: String },
    overrideBy:         { type: String },      // firebase UID of admin
    overrideExpiresAt:  { type: Date },

    // ── Usage counters (refreshed by plan_limit_service) ──────────────────────
    usageCounters: {
      staffCount:         { type: Number, default: 0 },
      productCount:       { type: Number, default: 0 },
      ordersThisMonth:    { type: Number, default: 0 },
      lastCountedAt:      { type: Date },
    },
  },
  { timestamps: true }
);

// Index for fast expiry sweeps (background job checks currentPeriodEnd)
storeSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

module.exports = mongoose.model('StoreSubscription', storeSubscriptionSchema);
