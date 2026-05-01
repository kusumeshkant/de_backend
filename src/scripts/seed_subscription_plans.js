/**
 * seed_subscription_plans.js
 *
 * Seeds the 3 public plans + 2 internal plans into the DB.
 * Public:   Starter / Growth / Enterprise
 * Internal: Trial (auto-assigned to new stores), Grandfathered (existing stores)
 *
 * Idempotent — uses upsert by name so it's safe to re-run.
 *
 * Run from repo root:
 *   node src/scripts/seed_subscription_plans.js
 *
 * ⚠ SYNC RULE — website (dq_website/lib/constants.ts → PRICING_PLANS) is the
 * source of truth for pricing. When prices/features change on the website,
 * update this file to match and re-run the seed. The admin app reads plans live
 * from the API and auto-syncs whenever the DB is updated.
 */

require('dotenv').config();
const mongoose = require('mongoose');

require('../models/SubscriptionPlan');
const { connectDB }      = require('../db/connection');
const SubscriptionPlan   = require('../models/SubscriptionPlan');
const { PLAN_NAMES, UNLIMITED } = require('../constants/feature_keys');

// ─────────────────────────────────────────────────────────────────────────────
// PLAN DEFINITIONS — mirrors dq_website/lib/constants.ts → PRICING_PLANS
//
// Public plans (isVisible: true)  — shown in pricing, purchasable via Razorpay
//   Starter     ₹2,999/mo  — analytics + bulk upload, 3 staff, 500 orders, 1 store
//   Growth      ₹5,999/mo  — + coupons, advanced reports, unlimited orders, 3 stores
//   Enterprise  custom     — contact sales, unlimited everything
//
// Internal plans (isVisible: false) — auto-assigned, never shown in pricing UI
//   Trial        — every new store, 30 days, same features as Growth
//   Grandfathered — existing stores, 90 days, same features as Enterprise
//
// ─────────────────────────────────────────────────────────────────────────────

const PLANS = [
  // ── STARTER ────────────────────────────────────────────────────────────────
  // Website: ₹2,999/mo · ₹29,990/year (save ₹5,998 = 2 months free)
  {
    name:        PLAN_NAMES.STARTER,
    displayName: 'Starter',
    description: 'Perfect for a single store getting started.',
    price:       { monthly: 2999, annual: 29990 }, // ₹2,999/mo · ₹2,499/mo billed annually
    features: {
      coupons:                   false,
      analytics:                 true,
      bulkUpload:                true,
      advancedReports:           false,
      staffPerformanceAnalytics: false,
      customerLtvAnalytics:      false,
      prioritySupport:           false,
      customBranding:            false,
      exportData:                false,
    },
    limits: {
      maxStaff:           3,
      maxOrdersPerMonth:  500,
      maxStores:          1,
    },
    trialDays:     0,
    graceDays:     7,
    isRecommended: false,
    isVisible:     true,
    displayOrder:  1,
  },

  // ── GROWTH ─────────────────────────────────────────────────────────────────
  // Website: ₹5,999/mo · ₹59,990/year (save ₹11,998 = 2 months free)
  {
    name:        PLAN_NAMES.GROWTH,
    displayName: 'Growth',
    description: 'For stores ready to scale with advanced tools.',
    price:       { monthly: 5999, annual: 59990 }, // ₹5,999/mo · ₹4,999/mo billed annually
    features: {
      coupons:                   true,
      analytics:                 true,
      bulkUpload:                true,
      advancedReports:           true,
      staffPerformanceAnalytics: true,
      customerLtvAnalytics:      false,
      prioritySupport:           false,
      customBranding:            false,
      exportData:                true,
    },
    limits: {
      maxStaff:           UNLIMITED,
      maxOrdersPerMonth:  UNLIMITED,
      maxStores:          3,
    },
    trialDays:     0,
    graceDays:     7,
    isRecommended: true,
    isVisible:     true,
    displayOrder:  2,
  },

  // ── ENTERPRISE ─────────────────────────────────────────────────────────────
  // Website: Custom pricing — "Talk to Us" (no Razorpay, contact sales)
  {
    name:        PLAN_NAMES.ENTERPRISE,
    displayName: 'Enterprise',
    description: 'Multi-outlet chains and large-format retail.',
    price:       { monthly: 0, annual: 0 },        // custom — billed offline
    features: {
      coupons:                   true,
      analytics:                 true,
      bulkUpload:                true,
      advancedReports:           true,
      staffPerformanceAnalytics: true,
      customerLtvAnalytics:      true,
      prioritySupport:           true,
      customBranding:            true,
      exportData:                true,
    },
    limits: {
      maxStaff:           UNLIMITED,
      maxOrdersPerMonth:  UNLIMITED,
      maxStores:          UNLIMITED,
    },
    isCustomPricing: true,   // admin app shows "Contact Us" instead of Razorpay
    trialDays:     0,
    graceDays:     30,
    isRecommended: false,
    isVisible:     true,
    displayOrder:  3,
  },

  // ── TRIAL (internal) ───────────────────────────────────────────────────────
  // Auto-assigned to every new store for 30 days. Same features as Growth.
  {
    name:        PLAN_NAMES.TRIAL,
    displayName: 'Trial',
    description: '30-day free trial — full Growth features, no payment required.',
    price:       { monthly: 0, annual: 0 },
    features: {
      coupons:                   true,
      analytics:                 true,
      bulkUpload:                true,
      advancedReports:           true,
      staffPerformanceAnalytics: true,
      customerLtvAnalytics:      false,
      prioritySupport:           false,
      customBranding:            false,
      exportData:                true,
    },
    limits: {
      maxStaff:           15,
      maxOrdersPerMonth:  5000,
      maxStores:          1,
    },
    trialDays:     30,
    graceDays:     7,
    isRecommended: false,
    isVisible:     false,   // not shown in pricing — assigned automatically
    displayOrder:  0,
  },

  // ── GRANDFATHERED (internal) ───────────────────────────────────────────────
  // Assigned to all stores that existed before paid plans launched.
  // 90-day free window with Pro-equivalent features.
  {
    name:        PLAN_NAMES.GRANDFATHERED,
    displayName: 'Grandfathered',
    description: 'Early-access plan for stores that onboarded before paid plans launched.',
    price:       { monthly: 0, annual: 0 },
    features: {
      coupons:                   true,
      analytics:                 true,
      bulkUpload:                true,
      advancedReports:           true,
      staffPerformanceAnalytics: true,
      customerLtvAnalytics:      true,
      prioritySupport:           false,
      customBranding:            false,
      exportData:                true,
    },
    limits: {
      maxStaff:           UNLIMITED,
      maxOrdersPerMonth:  UNLIMITED,
      maxStores:          UNLIMITED,
    },
    trialDays:     0,
    graceDays:     30,
    isRecommended: false,
    isVisible:     false,   // not shown in pricing
    displayOrder:  99,
  },
];

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI environment variable is not set');
  await connectDB(mongoUri);

  console.log('=== DQ Subscription Plans Seed ===\n');

  for (const plan of PLANS) {
    const result = await SubscriptionPlan.findOneAndUpdate(
      { name: plan.name },
      plan,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`  OK  ${plan.name.padEnd(15)} id=${result._id}`);
  }

  console.log('\n=== Seed complete ===');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
