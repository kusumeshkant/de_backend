const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  barcode: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number, required: true, default: 0 },
  imageUrl: { type: String },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Product', productSchema);
