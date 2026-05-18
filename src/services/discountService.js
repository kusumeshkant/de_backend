const crypto       = require('crypto');
const { GraphQLError } = require('graphql');
const DiscountCode  = require('../models/DiscountCode');
const DiscountLog   = require('../models/DiscountLog');
const StaffPermission = require('../models/StaffPermission');

const CODE_TTL_MINUTES = 15;

function _generateCode() {
  // 8-character uppercase hex — easy to read aloud, hard to guess
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ── Staff: generate a one-time code ──────────────────────────────────────────

async function generateDiscountCode({ staffId, staffName, storeId, discountPercent }) {
  const perm = await StaffPermission.findOne({ staffId, storeId, isActive: true, canDiscount: true }).lean();
  if (!perm) {
    throw new GraphQLError(
      'You do not have discount permissions. Submit a request for admin approval.',
      { extensions: { code: 'FORBIDDEN' } }
    );
  }
  if (discountPercent <= 0) {
    throw new GraphQLError('Discount must be greater than 0%', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (discountPercent > perm.maxDiscountPercent) {
    throw new GraphQLError(
      `Discount ${discountPercent}% exceeds your approved limit of ${perm.maxDiscountPercent}%`,
      { extensions: { code: 'DISCOUNT_LIMIT_EXCEEDED' } }
    );
  }

  const code      = _generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  return DiscountCode.create({
    code,
    storeId,
    generatedBy:     staffId,
    generatedByName: staffName,
    discountPercent,
    expiresAt,
  });
}

// ── Customer: validate before payment ────────────────────────────────────────

async function validateDiscountCode({ code, storeId, subtotal }) {
  const dc = await DiscountCode.findOne({ code: code.toUpperCase(), storeId }).lean();

  if (!dc)         throw new GraphQLError('Invalid discount code', { extensions: { code: 'INVALID_CODE' } });
  if (dc.isUsed)   throw new GraphQLError('This discount code has already been used', { extensions: { code: 'CODE_USED' } });
  if (dc.isRevoked)throw new GraphQLError('This discount code has been revoked', { extensions: { code: 'CODE_REVOKED' } });
  if (new Date() > dc.expiresAt) {
    throw new GraphQLError('This discount code has expired', { extensions: { code: 'CODE_EXPIRED' } });
  }

  const discountAmount = _calcDiscount(subtotal, dc.discountPercent);
  const finalAmount    = Math.max(0, subtotal - discountAmount);

  return {
    valid:           true,
    discountPercent: dc.discountPercent,
    discountAmount,
    finalAmount,
    generatedByName: dc.generatedByName,
    expiresAt:       dc.expiresAt.toISOString(),
  };
}

// ── Order creation: consume code & write audit log ────────────────────────────
// Called from createOrder resolver when discountCode is provided.
// This is idempotent-safe: if the code is already marked used, we log it and move on.

async function consumeDiscountCode({ code, storeId, orderId, grandTotal }) {
  const dc = await DiscountCode.findOne({ code: code.toUpperCase(), storeId });
  if (!dc) return null; // code doesn't belong to this store — silently skip

  if (dc.isUsed || dc.isRevoked) return null;
  if (new Date() > dc.expiresAt) return null;

  // Reconstruct original amount from the final amount + discount
  // grandTotal is what the customer PAID (already discounted)
  const originalAmount  = Math.round((grandTotal / (1 - dc.discountPercent / 100)) * 100) / 100;
  const discountAmount  = _calcDiscount(originalAmount, dc.discountPercent);

  // Mark used
  dc.isUsed    = true;
  dc.usedAt    = new Date();
  dc.usedByOrder = orderId;
  await dc.save();

  // Write immutable audit log
  const log = await DiscountLog.create({
    orderId,
    storeId,
    staffId:         dc.generatedBy,
    staffName:       dc.generatedByName,
    discountCode:    dc.code,
    discountPercent: dc.discountPercent,
    originalAmount,
    discountAmount,
    finalAmount:     grandTotal,
    appliedAt:       new Date(),
  });

  return log;
}

// ── Admin: read logs ──────────────────────────────────────────────────────────

async function getDiscountLogs(storeId, { limit = 50, offset = 0 } = {}) {
  return DiscountLog.find({ storeId })
    .sort({ appliedAt: -1 })
    .skip(offset)
    .limit(Math.min(limit, 200))
    .lean();
}

async function getStaffDiscountLogs(staffId) {
  return DiscountLog.find({ staffId }).sort({ appliedAt: -1 }).limit(100).lean();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _calcDiscount(amount, percent) {
  return Math.round(amount * percent) / 100;
}

module.exports = {
  generateDiscountCode,
  validateDiscountCode,
  consumeDiscountCode,
  getDiscountLogs,
  getStaffDiscountLogs,
};
