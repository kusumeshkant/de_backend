/**
 * Step 2 verification — store-ownership checks on updateStore / deleteStore.
 *
 * Both resolvers previously checked only `role == ADMIN`, so any store admin
 * could rename, deactivate, or delete any other tenant's store by passing its
 * id. These tests exercise the REAL resolvers and assert both the throw and
 * that the service was never reached.
 */

jest.mock('../src/utils/logger_cf', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: jest.fn() }),
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(), applicationDefault: jest.fn() },
  messaging: () => ({ send: jest.fn() }),
}));

jest.mock('../src/services/storeService', () => ({
  getStores: jest.fn(), getStoreById: jest.fn(), getStoreByCode: jest.fn(),
  getNearbyStores: jest.fn(), createStore: jest.fn(),
  getStoresPaginated: jest.fn(),
  updateStore: jest.fn().mockResolvedValue({ id: 'updated' }),
  deleteStore: jest.fn().mockResolvedValue(true),
}));

const { Roles } = require('../src/constants/roles');
const storeService = require('../src/services/storeService');
const resolvers = require('../src/resolvers');

const STORE_A = '000000000000000000000001';
const STORE_B = '000000000000000000000002';

const ctx = (overrides) => ({
  user: { uid: 'uid-x', email: 'x@example.com', phone: null },
  dbUser: { _id: 'u-x', firebase_uid: 'uid-x', name: 'X', ...overrides },
});

/** Admin who owns STORE_A. */
const storeAdminCtx = () => ctx({ roles: [Roles.ADMIN], storeId: STORE_A });
/** Brand-new registerAdmin'd account — admin role, no store yet. */
const freshAdminCtx = () => ctx({ roles: [Roles.CUSTOMER, Roles.ADMIN], storeId: null });
/** Explicitly granted platform operator. */
const platformAdminCtx = () => ctx({ roles: [Roles.ADMIN, Roles.PLATFORM_ADMIN], storeId: null });

const CROSS_TENANT = /do not belong to this store/;
const NO_STORE = /not linked to a store/;

beforeEach(() => {
  storeService.updateStore.mockClear();
  storeService.deleteStore.mockClear();
});

describe('Step 2 — updateStore is store-scoped', () => {
  it('REGRESSION: blocks a store admin from updating another tenant store', async () => {
    await expect(resolvers.Mutation.updateStore({}, { id: STORE_B, name: 'Hijacked' }, storeAdminCtx()))
      .rejects.toThrow(CROSS_TENANT);
    expect(storeService.updateStore).not.toHaveBeenCalled();
  });

  it('blocks a store-less admin', async () => {
    await expect(resolvers.Mutation.updateStore({}, { id: STORE_A, name: 'Nope' }, freshAdminCtx()))
      .rejects.toThrow(NO_STORE);
    expect(storeService.updateStore).not.toHaveBeenCalled();
  });

  it('allows a store admin to update their own store', async () => {
    await expect(resolvers.Mutation.updateStore({}, { id: STORE_A, name: 'Renamed' }, storeAdminCtx()))
      .resolves.toEqual({ id: 'updated' });
    expect(storeService.updateStore).toHaveBeenCalledWith(
      STORE_A, expect.objectContaining({ name: 'Renamed' })
    );
  });

  it('allows a PLATFORM_ADMIN to update any store', async () => {
    await expect(resolvers.Mutation.updateStore({}, { id: STORE_B, name: 'Ops edit' }, platformAdminCtx()))
      .resolves.toEqual({ id: 'updated' });
    expect(storeService.updateStore).toHaveBeenCalled();
  });
});

describe('Step 2 — deleteStore is store-scoped', () => {
  it('REGRESSION: blocks a store admin from deleting another tenant store', async () => {
    await expect(resolvers.Mutation.deleteStore({}, { id: STORE_B }, storeAdminCtx()))
      .rejects.toThrow(CROSS_TENANT);
    expect(storeService.deleteStore).not.toHaveBeenCalled();
  });

  it('blocks a store-less admin', async () => {
    await expect(resolvers.Mutation.deleteStore({}, { id: STORE_A }, freshAdminCtx()))
      .rejects.toThrow(NO_STORE);
    expect(storeService.deleteStore).not.toHaveBeenCalled();
  });

  it('allows a store admin to delete their own store', async () => {
    await expect(resolvers.Mutation.deleteStore({}, { id: STORE_A }, storeAdminCtx()))
      .resolves.toBe(true);
    expect(storeService.deleteStore).toHaveBeenCalledWith(STORE_A);
  });

  it('allows a PLATFORM_ADMIN to delete any store', async () => {
    await expect(resolvers.Mutation.deleteStore({}, { id: STORE_B }, platformAdminCtx()))
      .resolves.toBe(true);
    expect(storeService.deleteStore).toHaveBeenCalledWith(STORE_B);
  });
});

describe('Step 2 — a non-admin cannot reach either resolver', () => {
  const customerCtx = () => ctx({ roles: [Roles.CUSTOMER], storeId: null });

  it('updateStore rejects a customer', async () => {
    await expect(resolvers.Mutation.updateStore({}, { id: STORE_A, name: 'x' }, customerCtx()))
      .rejects.toThrow();
    expect(storeService.updateStore).not.toHaveBeenCalled();
  });

  it('deleteStore rejects a customer', async () => {
    await expect(resolvers.Mutation.deleteStore({}, { id: STORE_A }, customerCtx()))
      .rejects.toThrow();
    expect(storeService.deleteStore).not.toHaveBeenCalled();
  });
});
