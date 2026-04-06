/**
 * One-time import script — The Style Studio HSR
 * Data is hardcoded from StockReport-Export (12).xlsx parsed on 2026-03-27.
 *
 * Run ONCE from terminal:
 *   node src/import_style_studio.js
 *
 * Safe — does NOT wipe existing data.
 * Future updates go through dq_admin UI.
 */

const mongoose = require('mongoose');
const Store = require('./models/Store');
const Product = require('./models/Product');

const MONGODB_URI = process.env.MONGODB_URI ||
  'mongodb+srv://dq_db:Klpd420dq@cluster0.p7pe89o.mongodb.net/dq_app';

// ── Store ─────────────────────────────────────────────────────────────────────

const STORE = {
  name: 'The Style Studio',
  storeCode: 'SS-HSR-001',
  address: 'HSR Layout, Bengaluru',
  latitude: 12.9116,
  longitude: 77.6473,
};

// ── Products (parsed from StockReport-Export (12).xlsx) ───────────────────────

const PRODUCTS = [
  {
    barcode: '1000001717',
    sku: '#SSW-HSR-TPS003',
    name: 'Madewell Linen Vest Top',
    brand: 'Madewell',
    gender: 'Women',
    color: null,
    category: { main: 'Vest Top', sub: 'Linen' },
    size: { garment: '12', actual: 'L' },
    mrp: 2100,
    price: 2100,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001716',
    sku: '#SSW-HSR-DS003',
    name: 'J.Crew Long Printed Dresses',
    brand: 'J.Crew',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Long' },
    size: { garment: 'L', actual: 'XL' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001715',
    sku: '#SSW-HSR-DS003',
    name: 'J.Crew Long Printed Dresses',
    brand: 'J.Crew',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Long' },
    size: { garment: 'M', actual: 'L' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001714',
    sku: '#SSW-HSR-DS003',
    name: 'J.Crew Long Printed Dresses',
    brand: 'J.Crew',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Long' },
    size: { garment: 'S', actual: 'M' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001713',
    sku: '#SSW-HSR-DS003',
    name: 'American Eagle Short Denim Dresses',
    brand: 'American Eagle',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Short' },
    size: { garment: 'XS', actual: 'XS' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001712',
    sku: '#SSW-HSR-DS003',
    name: 'Aerie Midi Dresses',
    brand: 'Aerie',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Midi' },
    size: { garment: 'XS', actual: 'XS' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001711',
    sku: '#SSW-HSR-DS003',
    name: 'Aerie Midi Dresses',
    brand: 'Aerie',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Midi' },
    size: { garment: 'S', actual: 'S' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001710',
    sku: '#SSW-HSR-DS003',
    name: 'Aerie Midi Dresses',
    brand: 'Aerie',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Midi' },
    size: { garment: 'M', actual: 'M' },
    mrp: 1850,
    price: 1850,
    stock: 2,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001709',
    sku: '#SSW-HSR-DS003',
    name: 'J.Crew Printed Dresses',
    brand: 'J.Crew',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Printed' },
    size: { garment: 'M', actual: 'L' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
  {
    barcode: '1000001708',
    sku: '#SSW-HSR-DS003',
    name: 'J.Crew Printed Dresses',
    brand: 'J.Crew',
    gender: 'Women',
    color: null,
    category: { main: 'Dresses', sub: 'Printed' },
    size: { garment: 'S', actual: 'M' },
    mrp: 1850,
    price: 1850,
    stock: 1,
    reorderLevel: 2,
    isAvailable: true,
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.\n');

    // 1. Find or create the store
    let store = await Store.findOne({ storeCode: STORE.storeCode });
    if (store) {
      console.log(`Store already exists: ${store.name} (${store._id})`);
    } else {
      store = await Store.create(STORE);
      console.log(`Store created: ${store.name} (${store._id})`);
    }

    // 2. Insert products — skip duplicates
    let inserted = 0;
    let skipped = 0;

    for (const p of PRODUCTS) {
      const exists = await Product.findOne({ barcode: p.barcode });
      if (exists) {
        console.log(`  SKIP — ${p.barcode} already exists (${exists.name})`);
        skipped++;
        continue;
      }
      await Product.create({ ...p, storeId: store._id });
      console.log(`  INSERT — ${p.name} | ${p.barcode} | ₹${p.mrp} | stock: ${p.stock}`);
      inserted++;
    }

    console.log('\n── Import Complete ──────────────────────');
    console.log(`Store   : ${store.name} (${STORE.storeCode})`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Skipped : ${skipped} (already existed)`);
    console.log(`Total   : ${PRODUCTS.length}`);

  } catch (err) {
    console.error('Import failed:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

run();
