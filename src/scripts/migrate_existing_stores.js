/**
 * migrate_existing_stores.js
 *
 * One-time migration script: assigns the 'grandfathered' plan to all existing
 * stores that do not yet have a StoreSubscription document.
 *
 * Run from repo root:
 *   node src/scripts/migrate_existing_stores.js
 *
 * Safe to run multiple times — skips stores that already have a subscription.
 * All events are logged to subscription_events for auditability.
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Register all models before importing services
require('../models/SubscriptionPlan');
require('../models/StoreSubscription');
require('../models/SubscriptionEvent');
require('../models/Store');

const { connectDB } = require('../db/connection');
const Store              = require('../models/Store');
const StoreSubscription  = require('../models/StoreSubscription');
const { setGrandfathered } = require('../services/subscription_service');

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI environment variable is not set');
  await connectDB(mongoUri);

  console.log('=== DQ Subscription Migration: Existing Stores → Grandfathered ===\n');

  const allStores = await Store.find({}).select('_id name storeCode');
  console.log(`Found ${allStores.length} total stores.\n`);

  let skipped  = 0;
  let migrated = 0;
  let failed   = 0;

  for (const store of allStores) {
    const existing = await StoreSubscription.findOne({ storeId: store._id });
    if (existing) {
      console.log(`  SKIP   ${store.name} (${store.storeCode}) — already has status=${existing.status}`);
      skipped++;
      continue;
    }

    try {
      await setGrandfathered(store._id, {
        triggeredBy:     'system:migration',
        triggeredByRole: 'system',
      });
      console.log(`  OK     ${store.name} (${store.storeCode}) → grandfathered`);
      migrated++;
    } catch (err) {
      console.error(`  ERROR  ${store.name} (${store.storeCode}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Migration complete ===`);
  console.log(`  Migrated : ${migrated}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);

  if (failed > 0) {
    console.warn('\nSome stores failed migration. Re-run the script to retry only the failed ones.');
    process.exit(1);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
