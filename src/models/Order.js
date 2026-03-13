const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  barcode: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
  sku: { type: String },
  description: { type: String },
});

const staffActionSchema = new mongoose.Schema({
  staffId: { type: String },
  staffName: { type: String },
  action: { type: String }, // started_preparing | marked_ready | completed | cancelled | flagged_issue
  timestamp: { type: Date, default: Date.now },
  note: { type: String },
}, { _id: false });

const flaggedIssueSchema = new mongoose.Schema({
  reason: { type: String }, // wrong_items | payment_mismatch | customer_absent | other
  note: { type: String },
  staffId: { type: String },
  staffName: { type: String },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

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
  paymentStatus: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'success',
  },
  staffActions: { type: [staffActionSchema], default: [] },
  flaggedIssue: { type: flaggedIssueSchema, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Order', orderSchema);
