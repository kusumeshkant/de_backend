const mongoose = require('mongoose');

const cartCheckEventSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  storeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  itemCount: { type: Number, default: 0 },
  estimatedTotal: { type: Number, default: 0 },
  converted: { type: Boolean, default: false },
  convertedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  createdAt: { type: Date, default: Date.now },
});

// Auto-expire events after 7 days — keeps collection lean
cartCheckEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('CartCheckEvent', cartCheckEventSchema);
