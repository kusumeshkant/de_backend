const mongoose = require('mongoose');
const { GraphQLError } = require('graphql');
const User = require('../models/User');
const { Roles, RoleGroups } = require('../constants/roles');

/**
 * Canonical form for an email before storing or looking one up.
 * The schema applies lowercase+trim on write; this makes lookups match
 * explicitly rather than relying on Mongoose running setters on query filters.
 */
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email;
}

/**
 * Returns an existing user document, or creates one on first login.
 * New users default to roles: [Roles.CUSTOMER].
 *
 * Lookup is by firebase_uid — that is the identity key, and it is the only
 * field with a unique index today.
 *
 * If no document matches the UID but one already exists with the same email
 * under a DIFFERENT uid, this throws instead of creating a second document.
 * That situation means Firebase and MongoDB have drifted apart — almost always
 * because a Firebase account was deleted without removing its Mongo document,
 * leaving an orphan that still holds the email (see
 * DQ_DUPLICATE_ACCOUNTS_REVIEW.md). Creating a second document there is what
 * produced the duplicate accounts in dq_dev.
 *
 * Why throw rather than re-point the existing document at the new uid:
 * re-pointing would hand whoever holds the new uid full ownership of the
 * existing account — its roles, its store, its order history. Two people can
 * end up presenting the same email string (a deleted-and-reclaimed address, a
 * typo, a shared inbox), so silently transferring the account on an email match
 * alone is an account-takeover vector. A loud failure turns a silent data
 * problem into a support ticket, which is the correct trade for something this
 * rare.
 */
async function getOrCreateUser({ uid, phone, email }) {
  let user = await User.findOne({ firebase_uid: uid });
  if (user) return user;

  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail) {
    const existingByEmail = await User.findOne({
      email: normalizedEmail,
      firebase_uid: { $ne: uid },
    });
    if (existingByEmail) {
      throw new GraphQLError(
        'This email is already linked to another account. ' +
        'Please contact support so the existing account can be recovered.',
        {
          extensions: {
            code: 'EMAIL_ALREADY_LINKED',
            email: normalizedEmail,
            existingUserId: existingByEmail._id.toString(),
            // The uid on the existing record. If it no longer resolves in
            // Firebase, that record is an orphan and needs cleanup, not a merge.
            existingFirebaseUid: existingByEmail.firebase_uid,
            attemptedFirebaseUid: uid,
          },
        }
      );
    }
  }

  user = new User({
    firebase_uid: uid,
    phone,
    email: normalizedEmail,
    roles: [Roles.CUSTOMER],
  });
  await user.save();
  return user;
}

async function getProfile(userId) {
  return User.findById(userId);
}

async function updateProfile(userId, { name, phone, email }) {
  const update = {};
  if (name  !== undefined) update.name  = name;
  if (phone !== undefined) update.phone = phone;

  if (email !== undefined) {
    const normalizedEmail = normalizeEmail(email);
    // Same duplicate vector as getOrCreateUser, reached a different way: a user
    // editing their profile could otherwise take an email another account holds.
    // Guarding here keeps the future unique index from surfacing as a raw
    // E11000 duplicate-key 500.
    if (normalizedEmail) {
      const taken = await User.findOne({ email: normalizedEmail, _id: { $ne: userId } });
      if (taken) {
        throw new GraphQLError('That email is already in use by another account.', {
          extensions: { code: 'EMAIL_ALREADY_LINKED', email: normalizedEmail },
        });
      }
    }
    update.email = normalizedEmail;
  }

  return User.findByIdAndUpdate(userId, update, { new: true });
}

async function getUserByEmail(email) {
  return User.findOne({ email: normalizeEmail(email) });
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
  // Defence in depth — the resolver already rejects this, but this service is
  // also reachable from scripts. PLATFORM_ADMIN is operator-granted only.
  if (RoleGroups.NON_SELF_ASSIGNABLE.includes(role)) {
    throw new Error(`Refusing to assign non-self-assignable role '${role}' via updateUserRole`);
  }
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
  normalizeEmail,
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
