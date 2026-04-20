const mongoose = require('mongoose');
const { PLAN_NAMES, UNLIMITED } = require('../constants/feature_keys');

/**
 * SubscriptionPlan — the plan catalogue.
 *
 * Each document defines what a tier includes (binary features + numeric limits)
 * and its pricing. Plans are seeded once and rarely change.
 *
 * DO NOT delete plan documents — set isActive = false instead.
 * Existing subscriptions reference planId and must remain queryable.
 */
const subscriptionPlanSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    name: {
      type: String,
      required: true,
      unique: true,
      enum: Object.values(PLAN_NAMES),
    },
    displayName: { type: String, required: true },
    description:  { type: String, default: '' },

    // ── Pricing ───────────────────────────────────────────────────────────────
    price: {
      monthly: { type: Number, default: 0 },   // INR; 0 = free
      annual:  { type: Number, default: 0 },   // INR; 0 = free
    },

    // ── Binary feature flags ──────────────────────────────────────────────────
    features: {
      coupons:                     { type: Boolean, default: false },
      analytics:                   { type: Boolean, default: false },
      bulkUpload:                  { type: Boolean, default: false },
      advancedReports:             { type: Boolean, default: false },
      staffPerformanceAnalytics:   { type: Boolean, default: false },
      customerLtvAnalytics:        { type: Boolean, default: false },
      prioritySupport:             { type: Boolean, default: false },
      customBranding:              { type: Boolean, default: false },
      exportData:                  { type: Boolean, default: false },
    },

    // ── Numeric limits ────────────────────────────────────────────────────────
    // -1 (UNLIMITED sentinel) means no cap. The service layer enforces this.
    limits: {
      maxStaff:            { type: Number, default: 1 },
      maxOrdersPerMonth:   { type: Number, default: 100 },
      maxStores:           { type: Number, default: 1 },
    },

    // ── Trial / grace config ──────────────────────────────────────────────────
    trialDays: { type: Number, default: 0 },
    graceDays:  { type: Number, default: 7 },

    // ── Catalogue visibility ──────────────────────────────────────────────────
    isActive:       { type: Boolean, default: true },
    isRecommended:  { type: Boolean, default: false },
    isVisible:      { type: Boolean, default: true },   // shown in pricing page
    displayOrder:   { type: Number, default: 99 },

    // ── Extensible metadata ───────────────────────────────────────────────────
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
