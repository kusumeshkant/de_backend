const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebase_uid: { type: String, required: true, unique: true },
  name:         { type: String },
  phone:        { type: String },
  email:        { type: String },
  fcmToken:     { type: String },
  roles:        { type: [String], enum: ['customer', 'staff', 'admin'], default: ['customer'] },
  storeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
  created_at:   { type: Date, default: Date.now },
});

// Virtual: primary role for any code that still reads user.role
// Priority: admin > staff > customer
userSchema.virtual('role').get(function () {
  if (this.roles.includes('admin'))  return 'admin';
  if (this.roles.includes('staff'))  return 'staff';
  return 'customer';
});

userSchema.set('toObject', { virtuals: true });
userSchema.set('toJSON',   { virtuals: true });

module.exports = mongoose.model('User', userSchema);
