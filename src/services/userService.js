const User = require('../models/User');

/**
 * Returns an existing user document, or creates one on first login.
 * Called after Firebase token is verified — we just store the UID.
 */
async function getOrCreateUser({ uid, phone, email }) {
  let user = await User.findOne({ firebase_uid: uid });
  if (!user) {
    user = new User({ firebase_uid: uid, phone, email });
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

async function getAllStaff() {
  return await User.find({ role: { $in: ['staff', 'admin'] } }).sort({ name: 1 });
}

async function updateUserRole(userId, role, storeId) {
  const update = { role };
  if (storeId !== undefined) update.storeId = storeId ?? null;
  return await User.findByIdAndUpdate(userId, update, { new: true });
}

module.exports = { getOrCreateUser, getProfile, updateProfile, updateFcmToken, getAllStaff, updateUserRole, getUserByEmail };
