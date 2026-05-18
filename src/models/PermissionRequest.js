const mongoose = require('mongoose');

const REQUEST_TYPES   = ['discount', 'product_edit', 'bulk_upload'];
const REQUEST_STATUS  = ['pending', 'approved', 'rejected', 'revoked'];
const PRODUCT_PERM_KEYS = ['canEditProductInfo', 'canAddProduct', 'canDeleteProduct'];

/**
 * PermissionRequest — immutable audit record of every access request.
 * One request per (staff, store, type) at a time (no duplicate pending).
 * Approved/rejected/revoked requests are kept forever for audit.
 */
const permissionRequestSchema = new mongoose.Schema(
  {
    staffId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
    staffName:  { type: String, required: true },
    staffEmail: { type: String },
    storeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },

    requestType: { type: String, enum: REQUEST_TYPES, required: true },
    reason:      { type: String, required: true, maxlength: 500 },

    // Discount-specific
    requestedMaxDiscountPercent: { type: Number, min: 0, max: 100 },

    // Product-specific — subset the staff is asking for
    requestedProductPerms: [{ type: String, enum: PRODUCT_PERM_KEYS }],

    status: { type: String, enum: REQUEST_STATUS, default: 'pending' },

    // Admin response
    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt:  { type: Date },
    reviewNote:  { type: String, maxlength: 500 },

    // What was actually granted (may be less than requested)
    grantedMaxDiscountPercent: { type: Number, min: 0, max: 100 },
    grantedProductPerms:       [{ type: String, enum: PRODUCT_PERM_KEYS }],
  },
  { timestamps: true }
);

permissionRequestSchema.index({ storeId: 1, status: 1 });
permissionRequestSchema.index({ staffId: 1, storeId: 1 });
permissionRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PermissionRequest', permissionRequestSchema);
