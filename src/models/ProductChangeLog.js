const mongoose = require('mongoose');

const CHANGE_TYPES = ['created', 'updated', 'deleted', 'bulk_uploaded'];

/**
 * ProductChangeLog — append-only audit record for every product mutation.
 * oldValues / newValues store only the fields that actually changed.
 */
const productChangeLogSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, // null on bulk-create rows
    storeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
    barcode:   { type: String },

    changedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedByName:   { type: String, required: true },
    changedByRole:   { type: String, required: true },

    changeType:    { type: String, enum: CHANGE_TYPES, required: true },
    changedFields: [{ type: String }],

    // Stored as plain objects — not sub-schema so any field is captured
    oldValues: { type: mongoose.Schema.Types.Mixed },
    newValues: { type: mongoose.Schema.Types.Mixed },

    // Back-reference for rows created via bulk upload
    uploadLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'UploadLog' },
  },
  { timestamps: true }
);

productChangeLogSchema.index({ storeId: 1, createdAt: -1 });
productChangeLogSchema.index({ changedBy: 1 });
productChangeLogSchema.index({ productId: 1 });

module.exports = mongoose.model('ProductChangeLog', productChangeLogSchema);
