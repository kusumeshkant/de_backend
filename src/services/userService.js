const mongoose = require('mongoose');
const User = require('../models/User');
const { Roles, RoleGroups } = require('../constants/roles');

/**
 * Returns an existing user document, or creates one on first login.
 * New users default to roles: [Roles.CUSTOMER].
 */
async function getOrCreateUser({ uid, phone, email }) {
  let user = await User.findOne({ firebase_uid: uid });
  if (!user) {
    user = new User({ firebase_uid: uid, phone, email, roles: [Roles.CUSTOMER] });
    await user.save();
  }
  return user;
}

async function getProfile(userId) {
  return User.findById(userId);
}

async function updateProfile(userId, { name, phone, email }) {
  const update = {};
  if (name  !== undefined) update.name  = name;
  if (phone !== undefined) update.phone = phone;
  if (email !== undefined) update.email = email;
  return User.findByIdAndUpdate(userId, update, { new: true });
}

async function getUserByEmail(email) {
  return User.findOne({ email });
}

async function updateFcmToken(userId, fcmToken) {
  return User.findByIdAndUpdate(userId, { fcmToken }, { new: true });
}

/** Returns all users who have staff or admin role */
async function getAllStaff(storeId = null) {
  const filter = { roles: { $in: RoleGroups.STORE_OPERATORS } };
  if (storeId) filter.storeId = storeId;
  return await User.find(filter).sort({ name: 1 });
}

/** Legacy single-role update — kept for updateUserRole mutation compatibility */
async function updateUserRole(userId, role, storeId) {
  const update = { $set: { roles: [role] } };
  if (storeId !== undefined) update.$set.storeId = storeId ?? null;
  return await User.findByIdAndUpdate(userId, update, { new: true });
}

/** Adds 'admin' role to a user and links their storeId */
async function upgradeToAdmin(userId, storeId) {
  return await User.findByIdAndUpdate(
    userId,
    { $addToSet: { roles: Roles.ADMIN }, $set: { storeId } },
    { new: true }
  );
}

/** Silently adds 'customer' role if not already present */
async function ensureCustomerRole(userId) {
  await User.findByIdAndUpdate(userId, { $addToSet: { roles: Roles.CUSTOMER } });
}

// ── Cursor helpers ─────────────────────────────────────────────────────────────

function _encodeCursor(id) {
  return Buffer.from(JSON.stringify({ id: id.toString() })).toString('base64');
}

function _decodeCursor(cursor) {
  try { return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); } catch { return null; }
}

// ── Paginated staff ────────────────────────────────────────────────────────────

async function getStaffPaginated({ first = 30, after = null, search = null, storeId = null } = {}) {
  const limit = Math.min(Math.max(1, first || 30), 100);

  const baseFilter = { roles: { $in: RoleGroups.STORE_OPERATORS } };
  if (storeId) baseFilter.storeId = storeId;
  if (search)  baseFilter.$or = [
    { name:  { $regex: search, $options: 'i' } },
    { email: { $regex: search, $options: 'i' } },
    { phone: { $regex: search, $options: 'i' } },
  ];

  const decoded = after ? _decodeCursor(after) : null;
  const cursorFilter = decoded
    ? { _id: { $gt: mongoose.Types.ObjectId.createFromHexString(decoded.id) } }
    : {};

  const [rows, totalCount] = await Promise.all([
    User.find({ ...baseFilter, ...cursorFilter }).sort({ name: 1, _id: 1 }).limit(limit + 1),
    User.countDocuments(baseFilter),
  ]);

  const hasNext = rows.length > limit;
  if (hasNext) rows.pop();
  const lastRow    = rows[rows.length - 1];
  const nextCursor = hasNext && lastRow ? _encodeCursor(lastRow._id) : null;

  return { items: rows, meta: { hasNext, nextCursor, totalCount } };
}

module.exports = {
  getOrCreateUser,
  getProfile,
  updateProfile,
  updateFcmToken,
  getAllStaff,
  getStaffPaginated,
  updateUserRole,
  upgradeToAdmin,
  ensureCustomerRole,
  getUserByEmail,
};
