const mongoose = require('mongoose');

// The server's record of what a Razorpay order is for. createOrder builds the
// Order ONLY from this record — never from client arguments (A3).
const pendingPaymentSchema = new mongoose.Schema({
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  storeId:         { type: mongoose.Schema.Types.ObjectId, required: true },
  // Server-built line items: { barcode, name, mrp, price, quantity, sku, description }
  // with name and price taken from the catalogue, not from the client.
  items:           { type: Array, required: true },
  subtotal:        { type: Number },               // before discount
  discountAmount:  { type: Number, default: 0 },
  total:           { type: Number },               // discounted subtotal (S-7: total + tax = serverTotal)
  tax:             { type: Number },
  serverTotal:     { type: Number, required: true }, // grand total actually charged
  amountPaise:     { type: Number },
  discountCode:    { type: String, default: null },
  // pending → consumed exactly once, atomically, by createOrder.
  status:          { type: String, enum: ['pending', 'consumed'], default: 'pending' },
  razorpayPaymentId: { type: String, default: null },
  consumedAt:      { type: Date, default: null },
  expiresAt:       { type: Date, default: () => new Date(Date.now() + 30 * 60 * 1000) },
}, { timestamps: true });

// Auto-delete abandoned pending payments after 30 minutes. createOrder unsets
// expiresAt when it consumes a record, so consumed records are kept for audit.
pendingPaymentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingPayment', pendingPaymentSchema);
