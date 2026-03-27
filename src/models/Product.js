const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  // ── Identification ──────────────────────────────
  barcode:     { type: String, required: true, unique: true },
  sku:         { type: String, unique: true, sparse: true },
  storeId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },

  // ── Basic Info ──────────────────────────────────
  name:        { type: String, required: true },
  description: { type: String },
  brand:       { type: String },
  gender:      { type: String, enum: ['Men', 'Women', 'Unisex', null] },
  color:       { type: String },
  imageUrl:    { type: String },

  // ── Category (nested) ───────────────────────────
  category: {
    main: { type: String },
    sub:  { type: String },
  },

  // ── Size ────────────────────────────────────────
  size: {
    garment: { type: String },  // brand label e.g. "12" or "S"
    actual:  { type: String },  // real size  e.g. "L"
  },

  // ── Pricing ─────────────────────────────────────
  mrp:   { type: Number, required: true, default: 0 },  // original tag price
  price: { type: Number, required: true, default: 0 },  // selling price

  // ── Stock ───────────────────────────────────────
  stock:        { type: Number, default: 0 },
  reorderLevel: { type: Number, default: 5 },
  isAvailable:  { type: Boolean, default: true },

}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
