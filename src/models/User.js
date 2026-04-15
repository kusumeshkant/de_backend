const mongoose = require('mongoose');
const { Roles, RoleGroups } = require('../constants/roles');

const userSchema = new mongoose.Schema({
  firebase_uid: { type: String, required: true, unique: true },
  name:         { type: String },
  phone:        { type: String },
  email:        { type: String },
  fcmToken:     { type: String },
  roles:        { type: [String], enum: RoleGroups.ALL, default: [Roles.CUSTOMER] },
  storeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
  created_at:   { type: Date, default: Date.now },
});

// Virtual: primary role for any code that still reads user.role
// Priority: admin > staff > customer
userSchema.virtual('role').get(function () {
  if (this.roles.includes(Roles.ADMIN))  return Roles.ADMIN;
  if (this.roles.includes(Roles.STAFF))  return Roles.STAFF;
  return Roles.CUSTOMER;
});

userSchema.set('toObject', { virtuals: true });
userSchema.set('toJSON',   { virtuals: true });

module.exports = mongoose.model('User', userSchema);
