/**
 * One-shot script: completely delete a user by email from both
 * Firebase Auth and MongoDB.
 * Usage: node src/scripts/delete_user_completely.js <email>
 */
require('dotenv').config();
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const path = require('path');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node src/scripts/delete_user_completely.js <email>');
  process.exit(1);
}

const serviceAccount = require(path.resolve(__dirname, '../../firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

(async () => {
  // ── Step 1: Firebase Auth ─────────────────────────────────────────────────
  let firebaseUid = null;
  try {
    const fbUser = await admin.auth().getUserByEmail(email);
    firebaseUid = fbUser.uid;
    console.log(`[Firebase] Found user: uid=${fbUser.uid} email=${fbUser.email}`);
    await admin.auth().deleteUser(fbUser.uid);
    console.log(`[Firebase] Deleted user: ${email}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.log(`[Firebase] No user found for: ${email} — skipping Firebase delete`);
    } else {
      console.error('[Firebase] Error:', err.message);
      process.exit(1);
    }
  }

  // ── Step 2: MongoDB ───────────────────────────────────────────────────────
  if (!process.env.MONGO_URI) {
    console.error('[MongoDB] MONGO_URI not set — cannot delete from MongoDB');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('[MongoDB] Connected');

  const User = require('../models/User');

  // Delete by firebase_uid if we got it, and also by email (catches orphaned docs)
  let deletedCount = 0;

  if (firebaseUid) {
    const byUid = await User.deleteOne({ firebase_uid: firebaseUid });
    deletedCount += byUid.deletedCount;
    if (byUid.deletedCount > 0) {
      console.log(`[MongoDB] Deleted user doc by firebase_uid=${firebaseUid}`);
    }
  }

  const byEmail = await User.deleteMany({ email, firebase_uid: { $ne: firebaseUid } });
  deletedCount += byEmail.deletedCount;
  if (byEmail.deletedCount > 0) {
    console.log(`[MongoDB] Deleted ${byEmail.deletedCount} additional doc(s) by email=${email}`);
  }

  if (deletedCount === 0) {
    console.log(`[MongoDB] No documents found for email=${email} — nothing to delete`);
  }

  await mongoose.disconnect();
  console.log('[MongoDB] Disconnected');
  console.log(`\nDone. ${email} fully removed from Firebase Auth + MongoDB.`);
  process.exit(0);
})();
