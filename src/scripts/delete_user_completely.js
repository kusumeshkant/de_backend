/**
 * Delete a user by email from BOTH Firebase Auth and MongoDB.
 *
 * Usage:
 *   node src/scripts/delete_user_completely.js <email>
 *   node src/scripts/delete_user_completely.js <email> --dry-run
 *
 * The actual logic lives in scripts/lib/delete_user.js so this script and
 * delete_firebase_user.js cannot drift apart — a half-delete (Firebase only)
 * is what produced the duplicate accounts in dq_dev.
 */
require('dotenv').config();
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const path = require('path');
const { deleteUserCompletely } = require('./lib/delete_user');

const email = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!email || email.startsWith('--')) {
  console.error('Usage: node src/scripts/delete_user_completely.js <email> [--dry-run]');
  process.exit(1);
}

const serviceAccount = require(path.resolve(__dirname, '../../firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set — refusing to run.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`[MongoDB] Connected to database: ${dbName}`);
  console.log(
    '[MongoDB] Confirm this is the database you intend to modify — local .env ' +
    'has pointed at dq_app while production runs dq_dev.\n'
  );

  const User = require('../models/User');

  try {
    const result = await deleteUserCompletely(email, { admin, User }, dryRun);
    console.log(
      `\n${dryRun ? 'DRY RUN — nothing was deleted.' : 'Done.'} ` +
      `firebaseDeleted=${result.firebaseDeleted} mongoDocs=${result.mongoDocs.length} ` +
      `mongoDeleted=${result.mongoDeleted}`
    );
  } catch (err) {
    console.error('Error:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
  process.exit(0);
})();
