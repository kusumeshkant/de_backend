/**
 * One-time cleanup script for role data corrupted by the old ensureCustomerRole hack.
 *
 * Affected pattern: users with roles: ['admin', 'customer'] or ['staff', 'customer']
 * The ensureCustomerRole mutation added 'customer' to admin/staff accounts when they
 * accidentally opened the customer app. This removes the corrupt 'customer' entry.
 *
 * Safe to run while the app is live — only removes the extra role, never adds one.
 * The role virtual field (admin > staff > customer priority) ensured these users
 * still behaved correctly, so no permissions are lost.
 *
 * Run with:
 *   MONGO_URI=<uri> node src/scripts/cleanup_roles.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI env var is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // Preview before changes
  const adminCorrupted = await User.countDocuments({ roles: { $all: ['admin', 'customer'] } });
  const staffCorrupted = await User.countDocuments({ roles: { $all: ['staff', 'customer'] } });
  console.log(`Found ${adminCorrupted} admin+customer accounts (corrupted)`);
  console.log(`Found ${staffCorrupted} staff+customer accounts (corrupted)`);

  if (adminCorrupted === 0 && staffCorrupted === 0) {
    console.log('No corrupted records found. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Remove 'customer' from admin accounts
  const adminResult = await User.updateMany(
    { roles: { $all: ['admin', 'customer'] } },
    { $pull: { roles: 'customer' } }
  );
  console.log(`Fixed ${adminResult.modifiedCount} admin accounts`);

  // Remove 'customer' from staff accounts
  const staffResult = await User.updateMany(
    { roles: { $all: ['staff', 'customer'] } },
    { $pull: { roles: 'customer' } }
  );
  console.log(`Fixed ${staffResult.modifiedCount} staff accounts`);

  // Verify
  const remaining = await User.countDocuments({
    roles: { $all: ['admin', 'customer'] }
  }) + await User.countDocuments({
    roles: { $all: ['staff', 'customer'] }
  });
  console.log(`Remaining corrupted records: ${remaining}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
