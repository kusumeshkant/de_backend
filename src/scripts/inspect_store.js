/**
 * inspect_store.js
 * Shows the most recently created store and all its products.
 *
 * Usage:
 *   node src/scripts/inspect_store.js
 *
 * Optional — target a specific store by name or ID:
 *   node src/scripts/inspect_store.js "My Store Name"
 *   node src/scripts/inspect_store.js 6631abc123def456
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Store   = require('../models/Store');
const Product = require('../models/Product');
const User    = require('../models/User');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const arg = process.argv[2];

  // ── Find the target store ──────────────────────────────────────────────────
  let store;
  if (!arg) {
    // No arg → most recently created store
    store = await Store.findOne().sort({ created_at: -1 });
  } else if (mongoose.Types.ObjectId.isValid(arg)) {
    store = await Store.findById(arg);
  } else {
    store = await Store.findOne({ name: new RegExp(arg, 'i') });
  }

  if (!store) {
    console.log('No store found.');
    process.exit(0);
  }

  // ── Store info ─────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════');
  console.log(`  STORE: ${store.name}`);
  console.log('═══════════════════════════════════════════');
  console.log(`  ID:         ${store._id}`);
  console.log(`  Code:       ${store.storeCode ?? '—'}`);
  console.log(`  Address:    ${store.address ?? '—'}`);
  console.log(`  Active:     ${store.isActive}`);
  console.log(`  Created:    ${store.created_at?.toLocaleString() ?? '—'}`);
  console.log('');

  // ── Admin / staff for this store ───────────────────────────────────────────
  const staff = await User.find({ storeId: store._id }).select('name email roles');
  console.log(`  USERS (${staff.length}):`);
  if (staff.length === 0) {
    console.log('    (none)');
  } else {
    staff.forEach(u => {
      console.log(`    • ${u.name ?? '—'} <${u.email}>  roles: [${u.roles?.join(', ')}]`);
    });
  }
  console.log('');

  // ── Products ───────────────────────────────────────────────────────────────
  const products = await Product.find({ storeId: store._id }).sort({ createdAt: -1 });
  console.log(`  PRODUCTS (${products.length}):`);
  console.log('───────────────────────────────────────────');

  if (products.length === 0) {
    console.log('  No products found for this store.');
  } else {
    products.forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.name}`);
      console.log(`      ID:       ${p._id}`);
      console.log(`      Barcode:  ${p.barcode}`);
      console.log(`      SKU:      ${p.sku ?? '—'}`);
      console.log(`      Category: ${p.category?.main ?? '—'} › ${p.category?.sub ?? '—'}`);
      console.log(`      Brand:    ${p.brand ?? '—'}`);
      console.log(`      Size:     garment=${p.size?.garment ?? '—'}  actual=${p.size?.actual ?? '—'}`);
      console.log(`      Color:    ${p.color ?? '—'}`);
      console.log(`      MRP:      ₹${p.mrp}   Price: ₹${p.price}`);
      console.log(`      Stock:    ${p.stock}   Reorder at: ${p.reorderLevel}`);
      console.log(`      Available:${p.isAvailable}`);
      console.log(`      Added:    ${p.createdAt?.toLocaleString() ?? '—'}`);
      console.log('');
    });
  }

  console.log('═══════════════════════════════════════════');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
