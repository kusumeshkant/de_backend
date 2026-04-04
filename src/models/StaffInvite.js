const mongoose = require('mongoose');

const staffInviteSchema = new mongoose.Schema({
  email:     { type: String, required: true, lowercase: true, trim: true },
  name:      { type: String, required: true, trim: true },
  storeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  storeName: { type: String },
  token:     { type: String, required: true, unique: true },  // 8-char uppercase code e.g. DQ-ABCD-1234
  expiresAt: { type: Date, required: true },
  used:      { type: Boolean, default: false },
  usedAt:    { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('StaffInvite', staffInviteSchema);
