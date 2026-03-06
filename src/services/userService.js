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

async function updateProfile(userId, { name }) {
  return User.findByIdAndUpdate(
    userId,
    { name },
    { new: true }
  );
}

async function updateFcmToken(userId, fcmToken) {
  return User.findByIdAndUpdate(userId, { fcmToken }, { new: true });
}

module.exports = { getOrCreateUser, getProfile, updateProfile, updateFcmToken };
