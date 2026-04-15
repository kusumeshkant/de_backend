/**
 * seed_subscription_plans.js
 *
 * Seeds the 6 default subscription plan documents into the DB.
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

const PLANS = [
  {
    name:         PLAN_NAMES.FREE,
    displayName:  'Free',
    description:  'Get started with basic store management — no payment required.',
    price:        { monthly: 0, annual: 0 },
    features: {
      coupons:                   false,
      analytics:                 false,
      bulkUpload:                false,
      advancedReports:           false,
      staffPerformanceAnalytics: false,
      customerLtvAnalytics:      false,
      prioritySupport:           false,
      customBranding:            false,
      exportData:                false,
    },
    limits: {
      maxStaff:           1,
      maxProducts:        50,
      maxOrdersPerMonth:  100,
      maxStores:          1,
    },
    trialDays:      0,
    graceDays:      7,
    isRecommended:  false,
    isVisible:      true,
    displayOrder:   1,
  },
  {
    name:         PLAN_NAMES.TRIAL,
    displayName:  'Trial',
    description:  '14-day free trial with full Starter features.',
    price:        { monthly: 0, annual: 0 },
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
      maxProducts:        200,
      maxOrdersPerMonth:  500,
      maxStores:          1,
    },
    trialDays:      14,
    graceDays:      7,
    isRecommended:  false,
    isVisible:      false,   // Not shown in pricing — assigned automatically
    displayOrder:   0,
  },
  {
    name:         PLAN_NAMES.STARTER,
    displayName:  'Starter',
    description:  'Everything a growing store needs to go digital.',
    price:        { monthly: 999, annual: 9588 },   // ₹999/mo or ₹799/mo billed annually
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
      maxProducts:        500,
      maxOrdersPerMonth:  1000,
      maxStores:          1,
    },
    trialDays:      0,
    graceDays:      7,
    isRecommended:  false,
    isVisible:      true,
    displayOrder:   2,
  },
  {
    name:         PLAN_NAMES.GROWTH,
    displayName:  'Growth',
    description:  'Advanced analytics and coupon engine for ambitious stores.',
    price:        { monthly: 2499, annual: 23988 },  // ₹2499/mo or ₹1999/mo billed annually
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
      maxProducts:        2000,
      maxOrdersPerMonth:  5000,
      maxStores:          1,
    },
    trialDays:      0,
    graceDays:      7,
    isRecommended:  true,
    isVisible:      true,
    displayOrder:   3,
  },
  {
    name:         PLAN_NAMES.PRO,
    displayName:  'Pro',
    description:  'Full platform with LTV analytics, branding, and priority support.',
    price:        { monthly: 4999, annual: 47988 },  // ₹4999/mo or ₹3999/mo billed annually
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
    trialDays:      0,
    graceDays:      14,
    isRecommended:  false,
    isVisible:      true,
    displayOrder:   4,
  },
  {
    name:         PLAN_NAMES.GRANDFATHERED,
    displayName:  'Grandfathered',
    description:  'Early-access plan for stores that onboarded before paid plans launched.',
    price:        { monthly: 0, annual: 0 },
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
    trialDays:      0,
    graceDays:      30,
    isRecommended:  false,
    isVisible:      false,   // Not shown in pricing
    displayOrder:   99,
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
