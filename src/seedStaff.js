/**
 * seedStaff.js
 *
 * Creates one staff Firebase Auth account per store and links it
 * to a MongoDB User document with role='staff' and the correct storeId.
 *
 * Run:  node src/seedStaff.js
 *
 * Safe to re-run — skips Firebase accounts that already exist and
 * upserts MongoDB documents by firebase_uid.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const Store = require('./models/Store');
const User = require('./models/User');
const { Roles } = require('./constants/roles');

// ── Firebase Admin init ────────────────────────────────────────────────────────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      ),
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
}

// ── Staff credential map: storeCode → email slug ──────────────────────────────
const STAFF_PASSWORD = 'DQStaff@123';

const storeSlug = (storeCode) =>
  storeCode.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateFirebaseUser(email, displayName) {
  try {
    // Try to get existing user first
    const existing = await admin.auth().getUserByEmail(email);
    console.log(`  ↩  Firebase user already exists: ${email} (${existing.uid})`);
    return existing.uid;
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      const created = await admin.auth().createUser({
        email,
        password: STAFF_PASSWORD,
        displayName,
        emailVerified: true,
      });
      console.log(`  ✓  Created Firebase user: ${email} (${created.uid})`);
      return created.uid;
    }
    throw err;
  }
}

async function upsertMongoUser({ firebase_uid, name, email, storeId }) {
  const result = await User.findOneAndUpdate(
    { firebase_uid },
    {
      firebase_uid,
      name,
      email,
      roles: [Roles.STAFF],
      storeId,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`  ✓  MongoDB user upserted: ${name} → storeId ${storeId}`);
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✓ Connected to MongoDB\n');

  const stores = await Store.find({}).sort({ name: 1 });
  console.log(`Found ${stores.length} stores:\n`);

  const credentials = [];

  for (const store of stores) {
    const slug = storeSlug(store.storeCode || store.name);
    const email = `staff.${slug}@dqapp.com`;
    const name = `${store.name} Staff`;

    console.log(`── ${store.name} (${store.storeCode}) ──`);

    const uid = await getOrCreateFirebaseUser(email, name);
    await upsertMongoUser({
      firebase_uid: uid,
      name,
      email,
      storeId: store._id,
    });

    credentials.push({
      store: store.name,
      storeCode: store.storeCode,
      email,
      password: STAFF_PASSWORD,
    });

    console.log();
  }

  // ── Print credentials table ────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  STAFF CREDENTIALS');
  console.log('═══════════════════════════════════════════════════════════');
  credentials.forEach((c) => {
    console.log(`  ${c.storeCode.padEnd(8)}  ${c.store.padEnd(12)}  ${c.email}`);
    console.log(`           Password: ${c.password}`);
    console.log();
  });
  console.log('═══════════════════════════════════════════════════════════');

  await mongoose.disconnect();
  console.log('\n✓ Done. Disconnected from MongoDB.');
}

main().catch((err) => {
  console.error('✗ Error:', err);
  process.exit(1);
});
