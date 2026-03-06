const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  barcode: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
});

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  items: [orderItemSchema],
  total: { type: Number, required: true },
  tax: { type: Number, required: true },
  grandTotal: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'preparing', 'ready', 'completed', 'cancelled'],
    default: 'pending',
  },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Order', orderSchema);
