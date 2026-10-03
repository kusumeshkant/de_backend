const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  barcode: { type: String, required: true },
  name: { type: String, required: true },
  mrp: { type: Number },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
  sku: { type: String },
  description: { type: String },
  // Snapshot of the catalogue at purchase time, so exit staff see what was paid for.
  color: { type: String },
  size: { type: String },
  // How the customer added the line. A client-supplied hint for exit staff
  // (typed barcodes deserve a closer look) — never used for pricing or access.
  entryMethod: { type: String, enum: ['scan', 'manual'], default: 'scan' },
});

const staffActionSchema = new mongoose.Schema({
  staffId: { type: String },
  staffName: { type: String },
  action: { type: String }, // started_preparing | marked_ready | completed | cancelled | flagged_issue | exited | manual_exit | flag_cleared
  timestamp: { type: Date, default: Date.now },
  note: { type: String },
}, { _id: false });

const flaggedIssueSchema = new mongoose.Schema({
  reason: { type: String }, // wrong_items | payment_mismatch | customer_absent | other
  note: { type: String },
  staffId: { type: String },
  staffName: { type: String },
  timestamp: { type: Date, default: Date.now },
  // An open flag blocks the exit; only an admin of the store can clear it.
  resolvedAt: { type: Date, default: null },
  resolvedBy: {
    staffId: { type: String },
    staffName: { type: String },
  },
  resolutionNote: { type: String },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  items: [orderItemSchema],
  total: { type: Number, required: true },        // discounted subtotal (S-7: total + tax = grandTotal)
  tax: { type: Number, required: true },
  grandTotal: { type: Number, required: true },
  discountAmount: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['pending', 'preparing', 'ready', 'completed', 'cancelled'],
    default: 'pending',
  },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },
  paymentStatus: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'success',
  },
  staffActions: { type: [staffActionSchema], default: [] },
  flaggedIssue: { type: flaggedIssueSchema, default: null },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },

  // ── Exit (A5 / F-10) ─────────────────────────────────────────────────────
  // Random, unguessable code behind the customer's exit QR ("DQX1:<exitCode>").
  // Only the order's owner ever receives it. Orders created before this field
  // existed have none; their raw-id QR is accepted once (see exitService).
  exitCode: { type: String },
  // Set exactly once, atomically, by completeExit. Its presence is what makes
  // the exit QR single-use.
  exitedAt: { type: Date, default: null },
  exitedBy: {
    staffId: { type: String },
    staffName: { type: String },
  },
  exitMethod: { type: String, enum: ['qr', 'manual'] },
  exitReason: { type: String },            // required for a manual exit
  exitRequestId: { type: String },         // makes a retried completeExit idempotent
  exitVerifiedLineIds: { type: [String], default: undefined },
});

// storeOrders sorted by time — every staff dashboard query hits this
orderSchema.index({ storeId: 1, createdAt: -1 });
// filter by status within a store — used for order queue views
orderSchema.index({ storeId: 1, status: 1 });
// customer order history — used by getMyOrders
orderSchema.index({ user: 1, createdAt: -1 });
// One order per Razorpay order (A3 backstop behind the atomic PendingPayment
// claim). Partial so legacy/manual orders without a Razorpay id are unaffected.
orderSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } }
);
// Exit QR lookup; unique so a code can only ever name one order.
orderSchema.index(
  { exitCode: 1 },
  { unique: true, partialFilterExpression: { exitCode: { $type: 'string' } } }
);

module.exports = mongoose.model('Order', orderSchema);
