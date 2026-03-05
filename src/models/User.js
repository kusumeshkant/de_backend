const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebase_uid: { type: String, required: true, unique: true },
  name: { type: String },
  phone: { type: String },
  email: { type: String },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
