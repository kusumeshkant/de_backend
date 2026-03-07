const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebase_uid: { type: String, required: true, unique: true },
  name: { type: String },
  phone: { type: String },
  email: { type: String },
  fcmToken: { type: String },
  role: { type: String, enum: ['customer', 'staff', 'admin'], default: 'customer' },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
