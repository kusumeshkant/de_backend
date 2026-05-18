const { GraphQLError } = require('graphql');
const StaffPermission   = require('../models/StaffPermission');
const PermissionRequest = require('../models/PermissionRequest');
const User              = require('../models/User');

const REQUEST_TYPES     = { DISCOUNT: 'discount', PRODUCT_EDIT: 'product_edit', BULK_UPLOAD: 'bulk_upload' };
const PRODUCT_PERM_KEYS = ['canEditProductInfo', 'canAddProduct', 'canDeleteProduct'];

// ── Staff: submit a request ───────────────────────────────────────────────────

async function requestPermission({
  staffId,
  storeId,
  requestType,
  reason,
  requestedMaxDiscountPercent,
  requestedProductPerms,
}) {
  if (!Object.values(REQUEST_TYPES).includes(requestType)) {
    throw new GraphQLError('Invalid request type', { extensions: { code: 'BAD_USER_INPUT' } });
  }

  const existing = await PermissionRequest.findOne({ staffId, storeId, requestType, status: 'pending' });
  if (existing) {
    throw new GraphQLError(
      'You already have a pending request of this type. Wait for admin review.',
      { extensions: { code: 'DUPLICATE_REQUEST' } }
    );
  }

  const user = await User.findById(staffId);
  if (!user) throw new GraphQLError('Staff not found', { extensions: { code: 'NOT_FOUND' } });

  if (requestType === REQUEST_TYPES.DISCOUNT) {
    if (!requestedMaxDiscountPercent || requestedMaxDiscountPercent <= 0) {
      throw new GraphQLError('Requested discount percent must be greater than 0', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    if (requestedMaxDiscountPercent > 50) {
      throw new GraphQLError('Cannot request more than 50% discount limit', { extensions: { code: 'BAD_USER_INPUT' } });
    }
  }

  if (requestType === REQUEST_TYPES.PRODUCT_EDIT) {
    if (!requestedProductPerms || requestedProductPerms.length === 0) {
      throw new GraphQLError('Specify at least one product permission to request', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const invalid = requestedProductPerms.filter(p => !PRODUCT_PERM_KEYS.includes(p));
    if (invalid.length > 0) {
      throw new GraphQLError(`Invalid product permission keys: ${invalid.join(', ')}`, { extensions: { code: 'BAD_USER_INPUT' } });
    }
  }

  return PermissionRequest.create({
    staffId,
    staffName:  user.name  || 'Unknown',
    staffEmail: user.email || '',
    storeId,
    requestType,
    reason: reason.trim(),
    requestedMaxDiscountPercent: requestType === REQUEST_TYPES.DISCOUNT ? requestedMaxDiscountPercent : undefined,
    requestedProductPerms:       requestType === REQUEST_TYPES.PRODUCT_EDIT ? requestedProductPerms : undefined,
    status: 'pending',
  });
}

// ── Admin: read requests ──────────────────────────────────────────────────────

async function getPendingRequests(storeId) {
  return PermissionRequest.find({ storeId, status: 'pending' }).sort({ createdAt: -1 }).lean();
}

async function getAllRequests(storeId, { status } = {}) {
  const filter = { storeId };
  if (status) filter.status = status;
  return PermissionRequest.find(filter).sort({ createdAt: -1 }).lean();
}

async function getMyRequests(staffId, storeId) {
  return PermissionRequest.find({ staffId, storeId }).sort({ createdAt: -1 }).lean();
}

// ── Admin: approve ────────────────────────────────────────────────────────────

async function approveRequest(requestId, {
  adminId,
  reviewNote,
  grantedMaxDiscountPercent,
  grantedProductPerms,
}) {
  const req = await PermissionRequest.findById(requestId);
  if (!req) throw new GraphQLError('Request not found', { extensions: { code: 'NOT_FOUND' } });
  if (req.status !== 'pending') {
    throw new GraphQLError('Request is no longer pending', { extensions: { code: 'INVALID_STATE' } });
  }

  const effectiveDiscountPct = grantedMaxDiscountPercent ?? req.requestedMaxDiscountPercent;
  const effectiveProductPerms = grantedProductPerms ?? req.requestedProductPerms ?? [];

  req.status    = 'approved';
  req.reviewedBy  = adminId;
  req.reviewedAt  = new Date();
  req.reviewNote  = reviewNote || '';
  req.grantedMaxDiscountPercent = req.requestType === REQUEST_TYPES.DISCOUNT ? effectiveDiscountPct : undefined;
  req.grantedProductPerms       = req.requestType === REQUEST_TYPES.PRODUCT_EDIT ? effectiveProductPerms : undefined;
  await req.save();

  await _applyApprovalToPermission(req, adminId);
  return req;
}

// ── Admin: reject ─────────────────────────────────────────────────────────────

async function rejectRequest(requestId, { adminId, reviewNote }) {
  const req = await PermissionRequest.findById(requestId);
  if (!req) throw new GraphQLError('Request not found', { extensions: { code: 'NOT_FOUND' } });
  if (req.status !== 'pending') {
    throw new GraphQLError('Request is no longer pending', { extensions: { code: 'INVALID_STATE' } });
  }

  req.status     = 'rejected';
  req.reviewedBy = adminId;
  req.reviewedAt = new Date();
  req.reviewNote = reviewNote || '';
  await req.save();
  return req;
}

// ── Admin: revoke ─────────────────────────────────────────────────────────────

async function revokePermission(staffId, storeId, { permissionType, adminId }) {
  const perm = await StaffPermission.findOneAndUpdate(
    { staffId, storeId },
    { $set: _revokeFields(permissionType), grantedBy: adminId, grantedAt: new Date() },
    { new: true }
  );

  // Mark approved requests of this type as revoked so history is accurate
  await PermissionRequest.updateMany(
    { staffId, storeId, requestType: permissionType, status: 'approved' },
    { $set: { status: 'revoked' } }
  );

  return perm;
}

function _revokeFields(permissionType) {
  switch (permissionType) {
    case REQUEST_TYPES.DISCOUNT:
      return { canDiscount: false, maxDiscountPercent: 0 };
    case REQUEST_TYPES.PRODUCT_EDIT:
      return { canEditProductInfo: false, canAddProduct: false, canDeleteProduct: false };
    case REQUEST_TYPES.BULK_UPLOAD:
      return { canBulkUploadProducts: false };
    default:
      throw new GraphQLError('Invalid permission type', { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

// ── Permission reads ──────────────────────────────────────────────────────────

async function getStaffPermissions(staffId, storeId) {
  const perm = await StaffPermission.findOne({ staffId, storeId });
  if (!perm) return _defaultPermissions(staffId, storeId);
  return perm;
}

async function checkPermission(staffId, storeId, permissionKey) {
  const perm = await StaffPermission.findOne({ staffId, storeId, isActive: true }).lean();
  if (!perm) return false;
  return !!perm[permissionKey];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _applyApprovalToPermission(req, adminId) {
  const update = { grantedBy: adminId, grantedAt: new Date(), isActive: true };

  if (req.requestType === REQUEST_TYPES.DISCOUNT) {
    update.canDiscount = true;
    update.maxDiscountPercent = req.grantedMaxDiscountPercent ?? 0;
  } else if (req.requestType === REQUEST_TYPES.PRODUCT_EDIT) {
    const perms = req.grantedProductPerms ?? [];
    if (perms.includes('canEditProductInfo')) update.canEditProductInfo = true;
    if (perms.includes('canAddProduct'))      update.canAddProduct      = true;
    if (perms.includes('canDeleteProduct'))   update.canDeleteProduct   = true;
  } else if (req.requestType === REQUEST_TYPES.BULK_UPLOAD) {
    update.canBulkUploadProducts = true;
  }

  await StaffPermission.findOneAndUpdate(
    { staffId: req.staffId, storeId: req.storeId },
    { $set: update },
    { upsert: true }
  );
}

function _defaultPermissions(staffId, storeId) {
  return {
    staffId,
    storeId,
    canDiscount:           false,
    maxDiscountPercent:    0,
    canEditProductInfo:    false,
    canAddProduct:         false,
    canDeleteProduct:      false,
    canBulkUploadProducts: false,
    grantedAt:             null,
    notes:                 null,
  };
}

module.exports = {
  requestPermission,
  getPendingRequests,
  getAllRequests,
  getMyRequests,
  approveRequest,
  rejectRequest,
  revokePermission,
  getStaffPermissions,
  checkPermission,
  REQUEST_TYPES,
  PRODUCT_PERM_KEYS,
};
