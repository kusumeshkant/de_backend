const mongoose = require('mongoose');

const pendingPaymentSchema = new mongoose.Schema({
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  storeId:         { type: mongoose.Schema.Types.ObjectId, required: true },
  items:           { type: Array, required: true },
  serverTotal:     { type: Number, required: true },
  discountCode:    { type: String, default: null },
  expiresAt:       { type: Date, default: () => new Date(Date.now() + 30 * 60 * 1000) },
}, { timestamps: true });

// Auto-delete abandoned pending payments after 30 minutes
pendingPaymentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingPayment', pendingPaymentSchema);
