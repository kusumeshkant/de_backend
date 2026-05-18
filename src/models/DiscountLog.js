const mongoose = require('mongoose');

/**
 * DiscountLog — append-only audit record created whenever a discount code
 * is successfully consumed by a createOrder call. Never updated after creation.
 */
const discountLogSchema = new mongoose.Schema(
  {
    orderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    storeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },

    staffId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    staffName: { type: String, required: true },

    discountCode:    { type: String, required: true },
    discountPercent: { type: Number, required: true },
    originalAmount:  { type: Number, required: true },
    discountAmount:  { type: Number, required: true },
    finalAmount:     { type: Number, required: true },

    appliedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

discountLogSchema.index({ storeId: 1, appliedAt: -1 });
discountLogSchema.index({ staffId: 1 });

module.exports = mongoose.model('DiscountLog', discountLogSchema);
