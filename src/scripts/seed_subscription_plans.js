/**
 * seed_subscription_plans.js
 *
 * Seeds the 3 public plans + 2 internal plans into the DB.
 * Public:   Starter / Growth / Pro
 * Internal: Trial (auto-assigned to new stores), Grandfathered (existing stores)
 *
 * Idempotent — uses upsert by name so it's safe to re-run.
 *
 * Run from repo root:
 *   node src/scripts/seed_subscription_plans.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

require('../models/SubscriptionPlan');
const { connectDB }      = require('../db/connection');
const SubscriptionPlan   = require('../models/SubscriptionPlan');
const { PLAN_NAMES, UNLIMITED } = require('../constants/feature_keys');

// ─────────────────────────────────────────────────────────────────────────────
// PLAN DEFINITIONS
//
// Public plans (isVisible: true)  — shown on pricing page, purchasable
//   Starter  ₹999/mo   — analytics + bulk upload, up to 5 staff, 500 orders/mo
//   Growth   ₹2499/mo  — + coupons, advanced reports, staff analytics, export, 15 staff, 5k orders/mo
//   Pro      ₹4999/mo  — full platform, unlimited staff + orders
//
// Internal plans (isVisible: false) — auto-assigned, never shown in pricing
//   Trial        — every new store, 14 days, same features as Growth
//   Grandfathered — existing stores, 90 days, same features as Pro
//
// maxProducts = UNLIMITED on all plans — product uploads are never blocked.
// ─────────────────────────────────────────────────────────────────────────────

const PLANS = [
  // ── STARTER ────────────────────────────────────────────────────────────────
  {
    name:        PLAN_NAMES.STARTER,
    displayName: 'Starter',
    description: 'Everything a growing store needs to go digital.',
    price:       { monthly: 999, annual: 9588 },   // ₹999/mo · ₹799/mo billed annually
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
      maxStaff:           5,
      maxProducts:        UNLIMITED,
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
  {
    name:        PLAN_NAMES.GROWTH,
    displayName: 'Growth',
    description: 'Advanced analytics and coupon engine for ambitious stores.',
    price:       { monthly: 2499, annual: 23988 }, // ₹2499/mo · ₹1999/mo billed annually
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
      maxProducts:        UNLIMITED,
      maxOrdersPerMonth:  5000,
      maxStores:          1,
    },
    trialDays:     0,
    graceDays:     7,
    isRecommended: true,
    isVisible:     true,
    displayOrder:  2,
  },

  // ── PRO ────────────────────────────────────────────────────────────────────
  {
    name:        PLAN_NAMES.PRO,
    displayName: 'Pro',
    description: 'Full platform — unlimited orders, LTV analytics, branding, and priority support.',
    price:       { monthly: 4999, annual: 47988 }, // ₹4999/mo · ₹3999/mo billed annually
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
      maxProducts:        UNLIMITED,
      maxOrdersPerMonth:  UNLIMITED,
      maxStores:          3,
    },
    trialDays:     0,
    graceDays:     14,
    isRecommended: false,
    isVisible:     true,
    displayOrder:  3,
  },

  // ── TRIAL (internal) ───────────────────────────────────────────────────────
  // Auto-assigned to every new store for 14 days. Same features as Growth.
  {
    name:        PLAN_NAMES.TRIAL,
    displayName: 'Trial',
    description: '14-day free trial — full Growth features, no payment required.',
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
      maxProducts:        UNLIMITED,
      maxOrdersPerMonth:  5000,
      maxStores:          1,
    },
    trialDays:     14,
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
      maxProducts:        UNLIMITED,
      maxOrdersPerMonth:  UNLIMITED,
      maxStores:          1,
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
