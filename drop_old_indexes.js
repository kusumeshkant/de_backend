// One-time migration: drop old global barcode/sku unique indexes
// Run: node drop_old_indexes.js
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const col = db.collection('products');

  const indexes = await col.indexes();
  console.log('Current indexes:', indexes.map(i => i.name));

  for (const name of ['sku_1_storeId_1']) {
    if (indexes.find(i => i.name === name)) {
      await col.dropIndex(name);
      console.log(`Dropped: ${name}`);
    } else {
      console.log(`Not found (skip): ${name}`);
    }
  }

  console.log('Done. Compound indexes will be created on next server start.');
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
