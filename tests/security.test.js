/**
 * Security unit tests — IDOR protection and tenancy guards.
 *
 * These import the REAL guards from src/utils/guards.js. Do not re-inline a
 * copy of a guard here: an earlier version of this file did exactly that, and
 * the copy kept asserting the old "no storeId = unrestricted platform admin"
 * behaviour long after that inference was identified as a privilege-escalation
 * hole. A test that mirrors the implementation cannot catch the implementation
 * changing.
 */

jest.mock('../src/utils/logger_cf', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { Roles } = require('../src/constants/roles');
const {
  hasRole,
  requireRole,
  isPlatformAdmin,
  requirePlatformAdmin,
  requireStoreOwnership,
  resolveStoreScope,
  requireTargetStore,
} = require('../src/utils/guards');

const STORE_A = '000000000000000000000001';
const STORE_B = '000000000000000000000002';

const storeAdmin = (storeId) => ({
  firebase_uid: 'uid-store-admin', roles: [Roles.ADMIN], storeId,
});
const platformAdmin = () => ({
  firebase_uid: 'uid-platform', roles: [Roles.ADMIN, Roles.PLATFORM_ADMIN], storeId: null,
});
/** A brand-new registerAdmin'd account: admin role, no store yet. */
const freshAdmin = () => ({
  firebase_uid: 'uid-fresh', roles: [Roles.CUSTOMER, Roles.ADMIN], storeId: null,
});

describe('requireStoreOwnership — IDOR protection', () => {
  it('allows an explicit PLATFORM_ADMIN to access any store', () => {
    expect(() => requireStoreOwnership(platformAdmin(), STORE_A)).not.toThrow();
    expect(() => requireStoreOwnership(platformAdmin(), STORE_B)).not.toThrow();
  });

  it('allows a store admin to access their own store', () => {
    expect(() => requireStoreOwnership(storeAdmin(STORE_A), STORE_A)).not.toThrow();
  });

  it('blocks a store admin from accessing a different store', () => {
    expect(() => requireStoreOwnership(storeAdmin(STORE_A), STORE_B))
      .toThrow('Access denied: you do not belong to this store');
  });

  it('REGRESSION: blocks a store-less admin instead of treating it as platform admin', () => {
    // This is the exact account state registerAdmin produces. Before the fix
    // this returned early and granted access to every store on the platform.
    expect(() => requireStoreOwnership(freshAdmin(), STORE_A)).toThrow(/not linked to a store/);
    expect(() => requireStoreOwnership(freshAdmin(), STORE_B)).toThrow(/not linked to a store/);
  });

  it('returns a NO_STORE_LINKED hint so the app can route to onboarding', () => {
    try {
      requireStoreOwnership(freshAdmin(), STORE_A);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.extensions.code).toBe('FORBIDDEN');
      expect(err.extensions.hint).toBe('NO_STORE_LINKED');
    }
  });

  it('blocks when targetStoreId is null or undefined', () => {
    expect(() => requireStoreOwnership(storeAdmin(STORE_A), null)).toThrow('Access denied');
    expect(() => requireStoreOwnership(storeAdmin(STORE_A), undefined)).toThrow('Access denied');
  });

  it('handles ObjectId toString comparison correctly', () => {
    const admin = { firebase_uid: 'u', roles: [Roles.ADMIN], storeId: { toString: () => STORE_A } };
    const target = { toString: () => STORE_A };
    expect(() => requireStoreOwnership(admin, target)).not.toThrow();
  });

  it('throws FORBIDDEN error code', () => {
    try {
      requireStoreOwnership(storeAdmin(STORE_A), STORE_B);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.extensions.code).toBe('FORBIDDEN');
    }
  });
});

describe('isPlatformAdmin / requirePlatformAdmin', () => {
  it('is true only for the explicit role, never inferred from a null storeId', () => {
    expect(isPlatformAdmin(platformAdmin())).toBe(true);
    expect(isPlatformAdmin(freshAdmin())).toBe(false);
    expect(isPlatformAdmin(storeAdmin(STORE_A))).toBe(false);
  });

  it('rejects a store-less admin', () => {
    expect(() => requirePlatformAdmin(freshAdmin()))
      .toThrow('This operation requires DQ platform administrator access');
  });

  it('rejects a store-bound admin', () => {
    expect(() => requirePlatformAdmin(storeAdmin(STORE_A))).toThrow(/platform administrator/);
  });

  it('accepts a platform admin', () => {
    expect(() => requirePlatformAdmin(platformAdmin())).not.toThrow();
  });
});

describe('resolveStoreScope — replaces the old effectiveStoreId ternary', () => {
  it('narrows a store-bound admin to their own store, ignoring a supplied storeId', () => {
    expect(resolveStoreScope(storeAdmin(STORE_A), STORE_B)).toBe(STORE_A);
  });

  it('REGRESSION: a store-less admin can no longer widen scope to all stores', () => {
    // Old behaviour: returned the client-supplied storeId, or null = every store.
    expect(() => resolveStoreScope(freshAdmin(), null)).toThrow(/platform administrator/);
    expect(() => resolveStoreScope(freshAdmin(), STORE_B)).toThrow(/platform administrator/);
  });

  it('lets a platform admin read all stores (null) or narrow to one', () => {
    expect(resolveStoreScope(platformAdmin(), null)).toBeNull();
    expect(resolveStoreScope(platformAdmin(), STORE_B)).toBe(STORE_B);
  });
});

describe('requireTargetStore — single-store writes', () => {
  it('returns the caller store for a store-bound admin', () => {
    expect(requireTargetStore(storeAdmin(STORE_A), STORE_B)).toBe(STORE_A);
  });

  it('rejects a store-less non-platform admin', () => {
    expect(() => requireTargetStore(freshAdmin(), STORE_A)).toThrow(/platform administrator/);
  });

  it('requires a platform admin to name a store explicitly', () => {
    expect(() => requireTargetStore(platformAdmin(), null)).toThrow('storeId is required');
    expect(requireTargetStore(platformAdmin(), STORE_B)).toBe(STORE_B);
  });
});

describe('requireRole still works alongside the new role', () => {
  it('treats a platform admin as an admin', () => {
    expect(hasRole(platformAdmin(), Roles.ADMIN)).toBe(true);
    expect(() => requireRole(platformAdmin(), Roles.ADMIN)).not.toThrow();
  });

  it('does not treat a customer as an admin', () => {
    const customer = { firebase_uid: 'c', roles: [Roles.CUSTOMER], storeId: null };
    expect(() => requireRole(customer, Roles.ADMIN)).toThrow(/requires admin access/);
  });
});
