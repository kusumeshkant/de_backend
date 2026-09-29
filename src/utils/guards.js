/**
 * Authorization guards — the single source of truth for who may do what.
 *
 * Extracted from resolvers.js so they can be unit-tested directly. Before this
 * split, tests/security.test.js kept an inline *copy* of requireStoreOwnership,
 * which meant the test could keep passing while the real guard changed. Import
 * from here; never re-implement a guard in a test.
 *
 * Request context shape (set by index.js / api/graphql.js):
 *   context.user   — Firebase identity { uid, email, phone } | null
 *   context.dbUser — MongoDB User doc  { _id, roles, ... }  | null
 *
 * Call order in every protected resolver:
 *   1. requireAuth(context)   — verifies Firebase token was valid
 *   2. requireDbUser(context) — verifies user exists in MongoDB
 *   3. requireRole(...)       — verifies the user holds a required role
 *   4. requireStoreOwnership / resolveStoreScope / requireTargetStore — tenancy
 */

const { GraphQLError } = require('graphql');
const { Roles } = require('../constants/roles');
const logger = require('./logger_cf');

/** Throws UNAUTHENTICATED if no valid Firebase token was present in the request. */
function requireAuth(context) {
  if (!context.user) {
    throw new GraphQLError('You must be logged in', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
}

/**
 * Returns context.dbUser, or throws UNAUTHENTICATED if the MongoDB user
 * document was not found.
 *
 * This can happen if:
 *   - The user authenticated with Firebase but never called validateAppAccess
 *     (which creates the document on first login).
 *   - The MongoDB document was manually deleted.
 *
 * @returns {Object} The MongoDB User document (lean plain object)
 */
function requireDbUser(context) {
  if (!context.dbUser) {
    throw new GraphQLError('Account not found. Please log in again.', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return context.dbUser;
}

/** Returns true if *user* (MongoDB doc) holds ANY of the given roles. */
function hasRole(user, ...roles) {
  return roles.some(r => user.roles?.includes(r));
}

/**
 * Throws FORBIDDEN if *user* does not hold at least one of the given roles.
 * Logs the rejection for the audit trail.
 */
function requireRole(user, ...roles) {
  if (!hasRole(user, ...roles)) {
    const required = roles.join(' or ');
    logger.warn(
      `RBAC denied: uid=${user.firebase_uid} has [${user.roles}], needs [${required}]`
    );
    throw new GraphQLError(`This operation requires ${required} access`, {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

/** Returns true if *user* holds the explicit cross-store platform operator role. */
function isPlatformAdmin(user) {
  return hasRole(user, Roles.PLATFORM_ADMIN);
}

/**
 * Throws FORBIDDEN unless *user* holds the explicit PLATFORM_ADMIN role.
 *
 * Guards every operation whose scope is "all stores" rather than one store.
 * Deliberately NOT satisfied by merely having no storeId — see the comment on
 * Roles.PLATFORM_ADMIN for why that inference was removed.
 */
function requirePlatformAdmin(user) {
  if (!isPlatformAdmin(user)) {
    logger.warn(
      `RBAC denied (platform scope): uid=${user.firebase_uid} has [${user.roles}] storeId=${user.storeId ?? 'null'}`
    );
    throw new GraphQLError('This operation requires DQ platform administrator access', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

/**
 * Throws FORBIDDEN if the calling user may not act on targetStoreId.
 *
 * Rules, in order:
 *   1. PLATFORM_ADMIN   → allowed for any store.
 *   2. Store-bound user → allowed only for their own store.
 *   3. Store-less user  → denied. An admin who has registered but not yet
 *      completed onboarding has no store to act on. The one exception is
 *      claiming a store via upgradeToAdmin, which does its own check.
 */
function requireStoreOwnership(user, targetStoreId) {
  if (isPlatformAdmin(user)) return;
  if (!user.storeId) {
    throw new GraphQLError(
      'Your account is not linked to a store yet. Complete store setup first.',
      { extensions: { code: 'FORBIDDEN', hint: 'NO_STORE_LINKED' } }
    );
  }
  if (!targetStoreId || user.storeId.toString() !== targetStoreId.toString()) {
    throw new GraphQLError('Access denied: you do not belong to this store', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

/**
 * Resolves the store scope for a query that can be either store-scoped or
 * platform-wide. Replaces the old `user.storeId ? user.storeId : storeId`
 * pattern, which silently widened to "all stores" for any store-less account.
 *
 * @returns {string|null} a storeId to filter by, or null meaning "all stores"
 *          (only ever returned to a PLATFORM_ADMIN).
 */
function resolveStoreScope(user, requestedStoreId = null) {
  if (user.storeId) return user.storeId.toString();
  requirePlatformAdmin(user);
  return requestedStoreId ? requestedStoreId.toString() : null;
}

/**
 * Same as resolveStoreScope but for mutations that must write to exactly one
 * store — "all stores" is not a valid target, so a platform admin must name one.
 *
 * @returns {string} a definite storeId
 */
function requireTargetStore(user, requestedStoreId = null) {
  if (user.storeId) return user.storeId.toString();
  requirePlatformAdmin(user);
  if (!requestedStoreId) {
    throw new GraphQLError('storeId is required for this operation', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return requestedStoreId.toString();
}

/**
 * Throws FORBIDDEN unless the given order belongs to a store the caller may act on.
 * Used by the staff/admin order resolvers, which previously skipped the check
 * entirely whenever the caller had no storeId.
 */
async function assertOrderInScope(user, orderId) {
  if (isPlatformAdmin(user)) return;
  const Order = require('../models/Order');
  const existingOrder = await Order.findById(orderId).select('storeId');
  if (!existingOrder || !user.storeId ||
      existingOrder.storeId?.toString() !== user.storeId.toString()) {
    throw new GraphQLError('Order does not belong to your store', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

module.exports = {
  requireAuth,
  requireDbUser,
  hasRole,
  requireRole,
  isPlatformAdmin,
  requirePlatformAdmin,
  requireStoreOwnership,
  resolveStoreScope,
  requireTargetStore,
  assertOrderInScope,
};
