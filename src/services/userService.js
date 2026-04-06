const User = require('../models/User');

/**
 * Returns an existing user document, or creates one on first login.
 * New users default to roles: ['customer'].
 */
async function getOrCreateUser({ uid, phone, email }) {
  let user = await User.findOne({ firebase_uid: uid });
  if (!user) {
    user = new User({ firebase_uid: uid, phone, email, roles: ['customer'] });
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
  const filter = { roles: { $in: ['staff', 'admin'] } };
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
    { $addToSet: { roles: 'admin' }, $set: { storeId } },
    { new: true }
  );
}

/** Silently adds 'customer' role if not already present */
async function ensureCustomerRole(userId) {
  await User.findByIdAndUpdate(userId, { $addToSet: { roles: 'customer' } });
}

module.exports = {
  getOrCreateUser,
  getProfile,
  updateProfile,
  updateFcmToken,
  getAllStaff,
  updateUserRole,
  upgradeToAdmin,
  ensureCustomerRole,
  getUserByEmail,
};
