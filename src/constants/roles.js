/**
 * Centralised role constants for the DQ platform.
 *
 * SINGLE SOURCE OF TRUTH — import this file everywhere roles are referenced.
 * Never use raw role strings in resolvers, services, models, or scripts.
 *
 * Adding a new role:
 *   1. Add it to Roles below.
 *   2. Add it to the User model enum (models/User.js).
 *   3. Add the corresponding AppId entry if the role has its own app.
 *   4. Add a RoleHint entry if validateAppAccess should return a specific hint.
 *   5. Add resolver guards for the new role's operations.
 */

/**
 * Role values as stored in MongoDB and sent over the API.
 * These strings are the canonical identifiers — do not change their values
 * without a DB migration + coordinated app release.
 *
 * @readonly
 */
const Roles = Object.freeze({
  CUSTOMER:    'customer',
  STAFF:       'staff',
  ADMIN:       'admin',

  /**
   * DQ platform operator — cross-store access.
   *
   * Held IN ADDITION to ADMIN, never instead of it, so every existing
   * requireRole(user, Roles.ADMIN) guard keeps working unchanged.
   *
   * This role is the ONLY thing that grants platform-wide reach. It is never
   * self-assignable: registerAdmin cannot produce it, no mutation grants it,
   * and the only supported way to set it is scripts/grant_platform_admin.js
   * run against the database by an operator.
   *
   * Historical note: before this role existed, `user.storeId == null` was
   * treated as "unrestricted platform admin". Because registerAdmin creates
   * exactly that state for any brand-new account, anyone who signed up and
   * stopped before onboarding got cross-store access. Absence of a store is
   * now treated as "not yet onboarded" (deny), not as privilege.
   */
  PLATFORM_ADMIN: 'platform_admin',

  // ── Future roles — uncomment and wire up when ready ──────────────────────
  // VENDOR:      'vendor',
  // DELIVERY:    'delivery',
  // FRANCHISE:   'franchise',
});

/**
 * App identifiers used in the validateAppAccess(appId) gate.
 * Each app has one canonical ID that maps to a required role set.
 *
 * @readonly
 */
const AppId = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  STAFF:    'STAFF',
  ADMIN:    'ADMIN',

  // ── Future apps ───────────────────────────────────────────────────────────
  // VENDOR:   'VENDOR',
  // DELIVERY: 'DELIVERY',
});

/**
 * Hint strings sent in FORBIDDEN error extensions.
 * Lets the Flutter client show the correct dialog without parsing message text.
 *
 * @readonly
 */
const RoleHint = Object.freeze({
  STAFF_NO_CUSTOMER: 'STAFF_NO_CUSTOMER',
  ADMIN_NO_CUSTOMER: 'ADMIN_NO_CUSTOMER',
  NO_CUSTOMER:       'NO_CUSTOMER',

  // ── Future hints ──────────────────────────────────────────────────────────
  // VENDOR_NO_CUSTOMER:   'VENDOR_NO_CUSTOMER',
  // DELIVERY_NO_CUSTOMER: 'DELIVERY_NO_CUSTOMER',
});

/**
 * Convenience sets for common role group queries.
 * Use these in MongoDB $in filters and requireRole() calls instead of
 * repeating the same array literals across files.
 *
 * @readonly
 */
const RoleGroups = Object.freeze({
  /** Roles that can manage store operations */
  STORE_OPERATORS: [Roles.STAFF, Roles.ADMIN],

  /** Roles that have elevated platform access */
  ELEVATED: [Roles.STAFF, Roles.ADMIN],

  /**
   * Roles that are NEVER self-assignable through the API.
   * Guard any future role-granting mutation against this list.
   */
  NON_SELF_ASSIGNABLE: [Roles.PLATFORM_ADMIN],

  /** All defined roles — used for validation and DB enum */
  ALL: Object.values(Roles),
});

module.exports = { Roles, AppId, RoleHint, RoleGroups };
