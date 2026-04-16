const mongoose = require('mongoose');
const { SUBSCRIPTION_EVENT } = require('../constants/feature_keys');

/**
 * SubscriptionEvent — append-only audit log for all subscription state changes.
 *
 * Rules:
 *  - Never update or delete documents. Append only.
 *  - Every status transition in subscription_service MUST emit an event.
 *  - triggeredBy is the firebase UID (or 'system' for automated transitions).
 */
const subscriptionEventSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      enum: Object.values(SUBSCRIPTION_EVENT),
    },
    fromPlanId:   { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    toPlanId:     { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    triggeredBy:  { type: String, default: 'system' },  // firebase UID or 'system'
    triggeredByRole: { type: String },
    paymentId:    { type: String },
    metadata:     { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    // Ensure updatedAt is never set — this is append-only
    versionKey: false,
  }
);

// Remove updatedAt from the schema — events are immutable
subscriptionEventSchema.set('timestamps', { createdAt: true, updatedAt: false });

module.exports = mongoose.model('SubscriptionEvent', subscriptionEventSchema);
