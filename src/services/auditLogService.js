const ProductChangeLog = require('../models/ProductChangeLog');

// ── Product audit helpers ─────────────────────────────────────────────────────
// Called from resolvers immediately after each product mutation succeeds.
// Failures are fire-and-forget (logged to console, never thrown to caller).

async function logProductCreate({ product, changedBy, changedByName, changedByRole }) {
  try {
    await ProductChangeLog.create({
      productId:     product._id,
      storeId:       product.storeId,
      barcode:       product.barcode,
      changedBy,
      changedByName,
      changedByRole,
      changeType:    'created',
      changedFields: Object.keys(_productSnapshot(product)),
      oldValues:     null,
      newValues:     _productSnapshot(product),
    });
  } catch (e) {
    console.error('[auditLog] logProductCreate failed:', e.message);
  }
}

async function logProductUpdate({ productId, storeId, barcode, oldProduct, updates, changedBy, changedByName, changedByRole }) {
  try {
    const changedFields = Object.keys(updates).filter(
      k => updates[k] !== undefined && String(updates[k]) !== String(oldProduct[k])
    );
    if (changedFields.length === 0) return;

    const oldSnapshot = {};
    const newSnapshot = {};
    changedFields.forEach(k => {
      oldSnapshot[k] = oldProduct[k];
      newSnapshot[k] = updates[k];
    });

    await ProductChangeLog.create({
      productId,
      storeId,
      barcode,
      changedBy,
      changedByName,
      changedByRole,
      changeType:    'updated',
      changedFields,
      oldValues:     oldSnapshot,
      newValues:     newSnapshot,
    });
  } catch (e) {
    console.error('[auditLog] logProductUpdate failed:', e.message);
  }
}

async function logProductDelete({ product, changedBy, changedByName, changedByRole }) {
  try {
    await ProductChangeLog.create({
      productId:     product._id,
      storeId:       product.storeId,
      barcode:       product.barcode,
      changedBy,
      changedByName,
      changedByRole,
      changeType:    'deleted',
      changedFields: [],
      oldValues:     _productSnapshot(product),
      newValues:     null,
    });
  } catch (e) {
    console.error('[auditLog] logProductDelete failed:', e.message);
  }
}

async function getProductChangeLogs(storeId, { limit = 50, offset = 0 } = {}) {
  return ProductChangeLog.find({ storeId })
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(Math.min(limit, 200))
    .lean();
}

function _productSnapshot(p) {
  return {
    barcode:  p.barcode,
    name:     p.name,
    brand:    p.brand,
    gender:   p.gender,
    color:    p.color,
    mrp:      p.mrp,
    price:    p.price,
    stock:    p.stock,
    isAvailable: p.isAvailable,
  };
}

module.exports = {
  logProductCreate,
  logProductUpdate,
  logProductDelete,
  getProductChangeLogs,
};
