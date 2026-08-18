/**
 * Grant or revoke the PLATFORM_ADMIN role.
 *
 * PLATFORM_ADMIN is deliberately not grantable through the GraphQL API — see
 * constants/roles.js. This script is the only supported way to set it, and it
 * must be run by an operator with database access.
 *
 * Usage:
 *   node src/scripts/grant_platform_admin.js --email ops@dqstore.in
 *   node src/scripts/grant_platform_admin.js --email ops@dqstore.in --revoke
 *   node src/scripts/grant_platform_admin.js --list
 *
 * Requires MONGO_URI in the environment (or .env).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { Roles } = require('../constants/roles');

function parseArgs(argv) {
  const args = { email: null, revoke: false, list: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--email') args.email = argv[++i];
    else if (argv[i] === '--revoke') args.revoke = true;
    else if (argv[i] === '--list') args.list = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.list && !args.email) {
    console.error('Usage: node src/scripts/grant_platform_admin.js --email <email> [--revoke]');
    console.error('       node src/scripts/grant_platform_admin.js --list');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  if (args.list) {
    const admins = await User.find({ roles: Roles.PLATFORM_ADMIN })
      .select('email name roles storeId');
    if (admins.length === 0) {
      console.log('No platform admins are configured.');
    } else {
      console.log(`Platform admins (${admins.length}):`);
      for (const a of admins) {
        console.log(`  ${a.email ?? '(no email)'}  name=${a.name ?? '-'}  storeId=${a.storeId ?? 'null'}`);
      }
    }
    await mongoose.disconnect();
    return;
  }

  const user = await User.findOne({ email: args.email });
  if (!user) {
    console.error(`No user found with email ${args.email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (args.revoke) {
    await User.updateOne({ _id: user._id }, { $pull: { roles: Roles.PLATFORM_ADMIN } });
    console.log(`Revoked PLATFORM_ADMIN from ${args.email}`);
  } else {
    // PLATFORM_ADMIN is held alongside ADMIN, never instead of it — every
    // existing requireRole(user, Roles.ADMIN) guard must keep passing.
    await User.updateOne(
      { _id: user._id },
      { $addToSet: { roles: { $each: [Roles.ADMIN, Roles.PLATFORM_ADMIN] } } }
    );
    console.log(`Granted PLATFORM_ADMIN to ${args.email}`);
    if (user.storeId) {
      console.log(
        `  Note: this account is also linked to store ${user.storeId}. Store-scoped\n` +
        '  queries will stay narrowed to that store. Unlink storeId if you want\n' +
        '  platform-wide reads to return all stores.'
      );
    }
  }

  const updated = await User.findById(user._id).select('roles');
  console.log(`  roles now: [${updated.roles}]`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
