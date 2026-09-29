const mongoose = require('mongoose');
const { Roles, RoleGroups } = require('../constants/roles');

const userSchema = new mongoose.Schema({
  firebase_uid: { type: String, required: true, unique: true },
  name:         { type: String },
  phone:        { type: String },
  // lowercase+trim matches StaffInvite.email and is a prerequisite for the
  // unique index: without normalisation, A@x.com and a@x.com are distinct
  // strings and a plain unique index would let both through.
  //
  // sparse: documents without an email (phone-only auth) are exempt, so several
  // such users can coexist. Without sparse, the second email-less document would
  // collide on null.
  //
  // The storage-level guard. getOrCreateUser/updateProfile also check in the
  // application layer and return EMAIL_ALREADY_LINKED, which gives a usable
  // error; this index is the backstop that holds even if a new code path
  // forgets to check. Added 2026-08-19 once dq_dev had no duplicate emails
  // left — see DQ_FULL_WIPE_COMPLETE.md.
  email:        { type: String, lowercase: true, trim: true, index: { unique: true, sparse: true } },
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
