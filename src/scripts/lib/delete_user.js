/**
 * Single source of truth for "delete a DQ user".
 *
 * A DQ user is TWO records: a Firebase Auth account (identity) and a MongoDB
 * User document (authorization). Deleting only one of them leaves the other
 * orphaned, and an orphaned Mongo document still holds the email — so the next
 * time that person signs up they get a new Firebase uid, getOrCreateUser finds
 * nothing by uid, and a SECOND Mongo document is created with the same email.
 *
 * That is exactly how the duplicate accounts in dq_dev were produced: the old
 * scripts/delete_firebase_user.js deleted the Firebase account and never
 * touched MongoDB. See DQ_DUPLICATE_ACCOUNTS_REVIEW.md.
 *
 * Both operator scripts now call this function, so there is one implementation
 * and no way to perform a half-delete by picking the wrong script.
 */

/**
 * Deletes a user from Firebase Auth and MongoDB.
 *
 * Deletes Mongo documents matching EITHER the Firebase uid OR the email, which
 * also sweeps up pre-existing orphans for that address.
 *
 * @param {string}  email        Address to delete.
 * @param {object}  deps
 * @param {object}  deps.admin   Initialised firebase-admin instance.
 * @param {object}  deps.User    Mongoose User model.
 * @param {object} [deps.logger] Defaults to console.
 * @param {boolean} [dryRun]     When true, reports what WOULD be deleted and
 *                               deletes nothing.
 * @returns {Promise<{firebaseUid: string|null, firebaseDeleted: boolean, mongoDeleted: number, mongoDocs: Array}>}
 */
async function deleteUserCompletely(email, { admin, User, logger = console }, dryRun = false) {
  if (!email) throw new Error('deleteUserCompletely: email is required');
  const normalized = String(email).trim().toLowerCase();
  const tag = dryRun ? '[DRY RUN] ' : '';

  const result = {
    firebaseUid: null,
    firebaseDeleted: false,
    mongoDeleted: 0,
    mongoDocs: [],
  };

  // ── Firebase Auth ───────────────────────────────────────────────────────────
  try {
    const fbUser = await admin.auth().getUserByEmail(normalized);
    result.firebaseUid = fbUser.uid;
    logger.log(`${tag}[Firebase] Found user: uid=${fbUser.uid} email=${fbUser.email}`);
    if (!dryRun) {
      await admin.auth().deleteUser(fbUser.uid);
      result.firebaseDeleted = true;
      logger.log(`[Firebase] Deleted user: ${normalized}`);
    }
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      logger.log(`${tag}[Firebase] No account for ${normalized} — nothing to delete there.`);
    } else {
      throw err;
    }
  }

  // ── MongoDB ─────────────────────────────────────────────────────────────────
  // Match on uid OR email so orphans (uid no longer in Firebase) are caught too.
  const filter = result.firebaseUid
    ? { $or: [{ firebase_uid: result.firebaseUid }, { email: normalized }] }
    : { email: normalized };

  const docs = await User.find(filter).lean();
  result.mongoDocs = docs.map((d) => ({
    _id: d._id.toString(),
    email: d.email,
    firebase_uid: d.firebase_uid,
    roles: d.roles,
    storeId: d.storeId ? d.storeId.toString() : null,
  }));

  for (const d of result.mongoDocs) {
    logger.log(
      `${tag}[MongoDB] ${dryRun ? 'would delete' : 'deleting'} _id=${d._id} ` +
      `uid=${d.firebase_uid} roles=[${d.roles}] storeId=${d.storeId}`
    );
  }

  if (!dryRun && docs.length > 0) {
    const res = await User.deleteMany(filter);
    result.mongoDeleted = res.deletedCount;
    logger.log(`[MongoDB] Deleted ${res.deletedCount} document(s) for ${normalized}`);
  }

  if (docs.length === 0) {
    logger.log(`${tag}[MongoDB] No documents found for ${normalized}`);
  }

  return result;
}

module.exports = { deleteUserCompletely };
