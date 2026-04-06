const Product = require('../models/Product');
const UploadLog = require('../models/UploadLog');
const Store = require('../models/Store');

async function getProductByBarcode(barcode, storeId) {
  return await Product.findOne({ barcode, storeId });
}

async function getProducts() {
  return await Product.find();
}

async function getStoreProducts(storeId) {
  return await Product.find({ storeId, stock: { $gt: 0 } }).sort({ name: 1 });
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

  for (const p of products) {
    // Skip products with zero stock — no point adding items that are out of stock
    if ((p.stock ?? 0) === 0) { skipped++; continue; }
    try {
      const filter = { barcode: p.barcode, storeId };
      const update = {
        storeId,
        barcode: p.barcode,
        sku:     p.sku     || undefined,
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
      // Remove undefined keys so we don't overwrite existing values with null
      Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

      const result = await Product.findOneAndUpdate(
        filter,
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      // If createdAt === updatedAt (within 1s), it was just created
      const diff = result.updatedAt - result.createdAt;
      diff < 1000 ? created++ : updated++;
    } catch (err) {
      errors.push({ barcode: p.barcode, message: err.message });
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

module.exports = { getProductByBarcode, getProducts, getStoreProducts, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, getUploadLogs };
