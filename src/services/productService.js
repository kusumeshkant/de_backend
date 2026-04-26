const mongoose = require('mongoose');
const Product = require('../models/Product');
const UploadLog = require('../models/UploadLog');
const Store = require('../models/Store');

// ── Cursor helpers ─────────────────────────────────────────────────────────────
// Cursor encodes: { id, sortValue }  base64-encoded JSON.
// This lets us do stable keyset pagination for any sort field, handling ties
// correctly without skip/offset.

function _encodeCursor(id, sortValue) {
  return Buffer.from(JSON.stringify({ id: id.toString(), v: sortValue?.toString() ?? '' })).toString('base64');
}

function _decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// ── Paginated product fetch ────────────────────────────────────────────────────

const VALID_SORT_FIELDS = new Set(['name', 'price', 'stock', 'createdAt', '_id']);
const DEFAULT_SORT      = 'createdAt';
const MAX_PAGE_SIZE     = 100;

/**
 * Cursor-based paginated product query.
 * Returns { items, meta: { hasNext, nextCursor, totalCount } }
 */
async function getProductsPaginated(storeId, {
  first    = 30,
  after    = null,
  search   = null,
  sortBy   = DEFAULT_SORT,
  sortDir  = null,
  filters  = {},
} = {}) {
  const limit     = Math.min(Math.max(1, first), MAX_PAGE_SIZE);
  const field     = VALID_SORT_FIELDS.has(sortBy) ? sortBy : DEFAULT_SORT;
  const isDefault = field === 'createdAt' || field === '_id';
  // Default sort for createdAt is newest-first; name/price/stock default asc
  const dir       = sortDir === 'asc' ? 1 : sortDir === 'desc' ? -1 : (isDefault ? -1 : 1);

  // ── Base filter ────────────────────────────────────────────────────────────
  const baseFilter = { storeId };

  if (search?.trim()) {
    const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    baseFilter.$or = [
      { name:    rx },
      { barcode: rx },
      { brand:   rx },
      { sku:     rx },
    ];
  }

  if (filters.brand)        baseFilter.brand           = new RegExp(`^${filters.brand}$`, 'i');
  if (filters.gender)       baseFilter.gender          = new RegExp(`^${filters.gender}$`, 'i');
  if (filters.categoryMain) baseFilter['category.main']= new RegExp(`^${filters.categoryMain}$`, 'i');
  if (filters.inStock)      baseFilter.stock           = { $gt: 0 };
  if (filters.lowStock)     Object.assign(baseFilter, {
    stock: { $gt: 0 },
    $expr: { $lte: ['$stock', { $ifNull: ['$reorderLevel', 0] }] },
  });

  // ── Cursor condition ────────────────────────────────────────────────────────
  const cursorFilter = {};
  if (after) {
    const decoded = _decodeCursor(after);
    if (decoded?.id) {
      const oid = new mongoose.Types.ObjectId(decoded.id);
      if (field === '_id' || field === 'createdAt') {
        // Simple _id keyset — works perfectly for insertion-order sort
        cursorFilter._id = dir === 1 ? { $gt: oid } : { $lt: oid };
      } else {
        // Compound keyset: handles ties in sort field by falling back to _id
        const sv = decoded.v;
        const numVal = Number(sv);
        const sortVal = isNaN(numVal) ? sv : numVal;
        if (dir === 1) {
          cursorFilter.$or = [
            { [field]: { $gt: sortVal } },
            { [field]: sortVal, _id: { $gt: oid } },
          ];
        } else {
          cursorFilter.$or = [
            { [field]: { $lt: sortVal } },
            { [field]: sortVal, _id: { $lt: oid } },
          ];
        }
      }
    }
  }

  const finalFilter = Object.keys(cursorFilter).length
    ? { $and: [baseFilter, cursorFilter] }
    : baseFilter;

  // ── Query ───────────────────────────────────────────────────────────────────
  const sortSpec = field === '_id' || field === 'createdAt'
    ? { _id: dir }
    : { [field]: dir, _id: dir }; // secondary _id sort for tie-breaking

  // Fetch limit+1 to detect hasNext without a separate COUNT query
  const [rows, totalCount] = await Promise.all([
    Product.find(finalFilter).sort(sortSpec).limit(limit + 1).lean(),
    Product.countDocuments(baseFilter),
  ]);

  const hasNext = rows.length > limit;
  if (hasNext) rows.pop();

  const nextCursor = hasNext
    ? _encodeCursor(rows[rows.length - 1]._id, rows[rows.length - 1][field])
    : null;

  return { items: rows, meta: { hasNext, nextCursor, totalCount } };
}

async function getProductByBarcode(barcode, storeId) {
  return await Product.findOne({ barcode, storeId });
}

async function getProducts() {
  return await Product.find();
}

async function getStoreProducts(storeId) {
  // Admin manage-products view — return ALL products regardless of stock.
  // The customer-facing app (dq_app) does not use this query; it scans barcodes.
  return await Product.find({ storeId }).sort({ name: 1 });
}

async function createProduct({ storeId, barcode, sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel }) {
  const product = new Product({
    storeId,
    barcode,
    sku: sku || undefined,
    name,
    description,
    brand,
    gender,
    color,
    category: { main: categoryMain, sub: categorySub },
    size: { garment: sizeGarment, actual: sizeActual },
    mrp: mrp ?? price,
    price,
    stock: stock ?? 0,
    reorderLevel: reorderLevel ?? 5,
  });
  return await product.save();
}

async function updateProduct(id, { sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel, isAvailable }) {
  const update = {};
  if (sku !== undefined)           update.sku = sku;
  if (name !== undefined)          update.name = name;
  if (description !== undefined)   update.description = description;
  if (brand !== undefined)         update.brand = brand;
  if (gender !== undefined)        update.gender = gender;
  if (color !== undefined)         update.color = color;
  if (categoryMain !== undefined)  update['category.main'] = categoryMain;
  if (categorySub !== undefined)   update['category.sub'] = categorySub;
  if (sizeGarment !== undefined)   update['size.garment'] = sizeGarment;
  if (sizeActual !== undefined)    update['size.actual'] = sizeActual;
  if (mrp !== undefined)           update.mrp = mrp;
  if (price !== undefined)         update.price = price;
  if (stock !== undefined)         update.stock = stock;
  if (reorderLevel !== undefined)  update.reorderLevel = reorderLevel;
  if (isAvailable !== undefined)   update.isAvailable = isAvailable;

  // If stock is being set to 0, delete the product and return last state
  if (stock === 0) {
    return await Product.findByIdAndDelete(id);
  }
  return await Product.findByIdAndUpdate(id, update, { new: true });
}

async function deleteProduct(id) {
  const result = await Product.findByIdAndDelete(id);
  return !!result;
}

// Upsert by barcode within a store:
//   - barcode exists in this store → update all fields
//   - barcode not found            → create new product
async function bulkUpsertProducts(storeId, products, { fileName, totalRows, totalColumns, uploadedBy, uploadedByName } = {}) {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  // Separate valid rows from invalid ones upfront
  const validProducts = [];
  for (const p of products) {
    if (!p.barcode || !p.name) { skipped++; continue; }
    validProducts.push(p);
  }

  // Build bulkWrite ops — single DB round-trip regardless of product count
  const CHUNK = 500; // MongoDB bulkWrite sweet spot
  for (let i = 0; i < validProducts.length; i += CHUNK) {
    const chunk = validProducts.slice(i, i + CHUNK);
    const ops = chunk.map(p => {
      const update = {
        storeId,
        barcode: p.barcode,
        name:    p.name,
        brand:   p.brand,
        gender:  p.gender ? (p.gender.charAt(0).toUpperCase() + p.gender.slice(1).toLowerCase()) : undefined,
        color:   p.color,
        'category.main': p.categoryMain,
        'category.sub':  p.categorySub,
        'size.garment':  p.sizeGarment,
        'size.actual':   p.sizeActual,
        mrp:   p.mrp   ?? p.price,
        price: p.price,
        stock: p.stock ?? 0,
      };
      if (p.sku) update.sku = p.sku;
      Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);
      return {
        updateOne: {
          filter: { barcode: p.barcode, storeId },
          update: { $set: update },
          upsert: true,
        },
      };
    });

    try {
      const result = await Product.bulkWrite(ops, { ordered: false });
      created += result.upsertedCount;
      updated += result.modifiedCount;
    } catch (err) {
      // bulkWrite throws on write errors but still returns partial results
      if (err.result) {
        created += err.result.upsertedCount ?? 0;
        updated += err.result.modifiedCount ?? 0;
      }
      (err.writeErrors ?? []).forEach(e =>
        errors.push({ barcode: chunk[e.index]?.barcode ?? '?', message: e.errmsg })
      );
    }
  }

  // Save upload log
  try {
    const store = await Store.findById(storeId).lean();
    await UploadLog.create({
      storeId,
      storeName: store?.name ?? null,
      uploadedBy:     uploadedBy ?? null,
      uploadedByName: uploadedByName ?? 'Unknown',
      fileName:       fileName ?? 'unknown.xlsx',
      totalRows:      totalRows ?? products.length,
      totalColumns:   totalColumns ?? 0,
      created,
      updated,
      skipped,
      errorCount: errors.length,
      errors,
    });
  } catch (_) { /* log save failure should not break the upload */ }

  return { created, updated, skipped, errors };
}

async function getUploadLogs(storeId) {
  return await UploadLog.find({ storeId }).sort({ createdAt: -1 }).limit(50).lean();
}

module.exports = { getProductByBarcode, getProducts, getStoreProducts, getProductsPaginated, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, getUploadLogs };
