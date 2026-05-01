const mongoose = require('mongoose');

/**
 * StaffPermission — one document per (staff, store) pair.
 * Admins always have all permissions by role; this only tracks
 * explicitly-granted staff-level overrides.
 */
const staffPermissionSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },

    // ── Discount ──────────────────────────────────────────────────────────────
    canDiscount:        { type: Boolean, default: false },
    maxDiscountPercent: { type: Number,  default: 0, min: 0, max: 100 },

    // ── Product ───────────────────────────────────────────────────────────────
    // Price + stock changes are excluded per spec; only info fields allowed.
    canEditProductInfo:   { type: Boolean, default: false },
    canAddProduct:        { type: Boolean, default: false },
    canDeleteProduct:     { type: Boolean, default: false },

    // ── Bulk upload (separate high-risk gate) ─────────────────────────────────
    canBulkUploadProducts: { type: Boolean, default: false },

    // ── Metadata ──────────────────────────────────────────────────────────────
    grantedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    grantedAt:  { type: Date },
    notes:      { type: String },
    isActive:   { type: Boolean, default: true },
  },
  { timestamps: true }
);

staffPermissionSchema.index({ staffId: 1, storeId: 1 }, { unique: true });
staffPermissionSchema.index({ storeId: 1 });

module.exports = mongoose.model('StaffPermission', staffPermissionSchema);
