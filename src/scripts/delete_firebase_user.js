/**
 * DEPRECATED ENTRY POINT — kept only so existing runbooks and shell history
 * do not silently do the wrong thing.
 *
 * This script used to delete the Firebase Auth account and nothing else. That
 * left the MongoDB User document orphaned, still holding the email, so the next
 * signup for that address created a SECOND Mongo document — which is how the
 * duplicate accounts in dq_dev were produced. See DQ_DUPLICATE_ACCOUNTS_REVIEW.md.
 *
 * Firebase-only deletion is no longer possible from this repo. This script now
 * performs the same FULL delete as delete_user_completely.js, via the shared
 * implementation in scripts/lib/delete_user.js.
 *
 * Usage:
 *   node src/scripts/delete_firebase_user.js <email> [--dry-run]
 *
 * Prefer: node src/scripts/delete_user_completely.js <email>
 */
require('dotenv').config();
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const path = require('path');
const { deleteUserCompletely } = require('./lib/delete_user');

const email = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!email || email.startsWith('--')) {
  console.error('Usage: node src/scripts/delete_firebase_user.js <email> [--dry-run]');
  process.exit(1);
}

console.warn('─────────────────────────────────────────────────────────────');
console.warn(' NOTE: this script no longer deletes ONLY the Firebase account.');
console.warn(' Firebase-only deletion orphans the MongoDB User document and');
console.warn(' causes duplicate accounts on the next signup, so it has been');
console.warn(' removed. This now performs a FULL delete (Firebase + MongoDB),');
console.warn(' identical to delete_user_completely.js.');
console.warn('─────────────────────────────────────────────────────────────\n');

const serviceAccount = require(path.resolve(__dirname, '../../firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set — refusing to run (a Firebase-only delete is not offered).');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`[MongoDB] Connected to database: ${mongoose.connection.db.databaseName}\n`);

  const User = require('../models/User');

  try {
    const result = await deleteUserCompletely(email, { admin, User }, dryRun);
    console.log(
      `\n${dryRun ? 'DRY RUN — nothing was deleted.' : 'Done.'} ` +
      `firebaseDeleted=${result.firebaseDeleted} mongoDeleted=${result.mongoDeleted}`
    );
  } catch (err) {
    console.error('Error:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
  process.exit(0);
})();
