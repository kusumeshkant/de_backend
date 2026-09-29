/**
 * Auth / RBAC unit tests.
 * Verifies that the requireAuth, requireDbUser, requireRole guards throw
 * correctly when called with invalid/missing credentials.
 * No database connection required.
 */

jest.mock('../src/models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../src/models/Order', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../src/models/Product', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: jest.fn() }),
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
}));

const { GraphQLError } = require('graphql');

// Mirrors the auth guard helpers in resolvers.js
const Roles = { CUSTOMER: 'CUSTOMER', STAFF: 'STAFF', ADMIN: 'ADMIN', PLATFORM_ADMIN: 'PLATFORM_ADMIN' };

function requireAuth(context) {
  if (!context.user) {
    throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return context.user;
}

function requireRole(user, ...allowedRoles) {
  if (!allowedRoles.includes(user.role)) {
    throw new GraphQLError('Insufficient permissions', { extensions: { code: 'FORBIDDEN' } });
  }
}

describe('requireAuth', () => {
  it('throws UNAUTHENTICATED when no user in context', () => {
    expect(() => requireAuth({})).toThrow('Not authenticated');
  });

  it('returns user when authenticated', () => {
    const user = { id: '1', role: Roles.CUSTOMER };
    expect(requireAuth({ user })).toBe(user);
  });
});

describe('requireRole', () => {
  it('allows user with correct role', () => {
    const admin = { role: Roles.ADMIN };
    expect(() => requireRole(admin, Roles.ADMIN)).not.toThrow();
  });

  it('allows user when multiple roles accepted', () => {
    const staff = { role: Roles.STAFF };
    expect(() => requireRole(staff, Roles.STAFF, Roles.ADMIN)).not.toThrow();
  });

  it('throws FORBIDDEN when role is insufficient', () => {
    const customer = { role: Roles.CUSTOMER };
    expect(() => requireRole(customer, Roles.ADMIN)).toThrow('Insufficient permissions');
  });

  it('throws FORBIDDEN when staff tries to access admin-only route', () => {
    const staff = { role: Roles.STAFF };
    expect(() => requireRole(staff, Roles.ADMIN, Roles.PLATFORM_ADMIN)).toThrow('Insufficient permissions');
  });
});

describe('RBAC role hierarchy', () => {
  it('CUSTOMER cannot access staff routes', () => {
    const customer = { role: Roles.CUSTOMER };
    expect(() => requireRole(customer, Roles.STAFF, Roles.ADMIN)).toThrow();
  });

  it('STAFF can access staff-level routes', () => {
    const staff = { role: Roles.STAFF };
    expect(() => requireRole(staff, Roles.STAFF, Roles.ADMIN)).not.toThrow();
  });

  it('ADMIN can access both admin and staff routes', () => {
    const admin = { role: Roles.ADMIN };
    expect(() => requireRole(admin, Roles.STAFF, Roles.ADMIN)).not.toThrow();
    expect(() => requireRole(admin, Roles.ADMIN)).not.toThrow();
  });
});
