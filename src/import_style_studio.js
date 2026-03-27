/**
 * One-time import script — The Style Studio HSR
 * Reads StockReport-Export Excel and inserts products into MongoDB.
 *
 * Run ONCE from terminal:
 *   node src/import_style_studio.js
 *
 * Safe — does NOT wipe existing data.
 * Future updates go through dq_admin UI.
 */

const mongoose = require('mongoose');
const xlsx = require('xlsx');
const path = require('path');
const Store = require('./models/Store');
const Product = require('./models/Product');

// ── Config ────────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI ||
  'mongodb+srv://dq_db:Klpd420dq@cluster0.p7pe89o.mongodb.net/dq_app';

const EXCEL_PATH = path.join(
  'D:\\D_Q_3rd_demo_app\\inventory\\the_style_studio\\24_03_2026',
  'StockReport-Export (12).xlsx'
);

const STORE_DATA = {
  name: 'The Style Studio',
  storeCode: 'SS-HSR-001',
  address: 'HSR Layout, Bengaluru',
  lat: 12.9116,
  lon: 77.6473,
};

// ── Excel Parser ──────────────────────────────────────────────────────────────

function parseExcel(filePath) {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });

  // Row 0 is header — skip it
  const headers = rows[0];
  console.log('Excel headers:', headers);

  const products = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    // Map columns by index (based on StockReport-Export structure):
    // 0:Barcode, 1:Product Name, 2:Sku Code, 3:Product Code,
    // 4:Category, 5:Subcategory, 6:Brand, 7:Color,
    // 8:GarmentSize, 9:ActualSize, 10:Location, 11:Gender,
    // 12:UQC, 13:MRP, 14:Opening, 15:Inward, 16:Sold,
    // ... 26:InStock, 27:Total Cost Value

    const barcode  = row[0]?.toString().trim();
    const name     = row[1]?.toString().trim();
    const sku      = row[2]?.toString().trim() || null;
    const catMain  = row[4]?.toString().trim() || null;
    const catSub   = row[5]?.toString().trim() || null;
    const brand    = row[6]?.toString().trim() || null;
    const color    = row[7]?.toString().trim() || null;
    const sizeGarment = row[8] != null ? row[8].toString().trim() : null;
    const sizeActual  = row[9]?.toString().trim() || null;
    const gender   = row[11]?.toString().trim() || null;
    const mrp      = parseFloat(row[13]) || 0;
    const inStock  = parseInt(row[26]) || 0;

    if (!barcode || !name) {
      console.warn(`Row ${i} skipped — missing barcode or name`);
      continue;
    }

    products.push({
      barcode,
      sku,
      name,
      brand,
      gender: ['Men', 'Women', 'Unisex'].includes(gender) ? gender : null,
      color: color || null,
      category: { main: catMain, sub: catSub },
      size: { garment: sizeGarment, actual: sizeActual },
      mrp,
      price: mrp,        // price = mrp for now — admin can update later
      stock: inStock,
      reorderLevel: 2,   // low threshold for boutique (small stock per item)
      isAvailable: true,
    });
  }

  return products;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.\n');

    // 1. Find or create the store
    let store = await Store.findOne({ storeCode: STORE_DATA.storeCode });

    if (store) {
      console.log(`Store already exists: ${store.name} (${store._id})`);
    } else {
      store = await Store.create(STORE_DATA);
      console.log(`Store created: ${store.name} (${store._id})`);
    }

    // 2. Parse Excel
    console.log('\nParsing Excel...');
    const products = parseExcel(EXCEL_PATH);
    console.log(`Parsed ${products.length} products from Excel.\n`);

    // 3. Insert products — skip duplicates (same barcode)
    let inserted = 0;
    let skipped = 0;

    for (const p of products) {
      const exists = await Product.findOne({ barcode: p.barcode });
      if (exists) {
        console.log(`  SKIP — barcode ${p.barcode} already exists (${exists.name})`);
        skipped++;
        continue;
      }

      await Product.create({ ...p, storeId: store._id });
      console.log(`  INSERT — ${p.name} | ${p.barcode} | ₹${p.mrp} | stock: ${p.stock}`);
      inserted++;
    }

    console.log('\n── Import Complete ──────────────────────');
    console.log(`Store  : ${store.name} (${STORE_DATA.storeCode})`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Skipped : ${skipped} (already existed)`);
    console.log(`Total   : ${products.length}`);

  } catch (err) {
    console.error('Import failed:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  }
}

run();
