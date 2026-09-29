/**
 * subscription_service.checkSubscriptionExpirySweep unit tests.
 * Verifies lapsed trial/active/grandfathered subscriptions move to grace period,
 * lapsed grace-period subscriptions move to expired, and admin-override /
 * already-lapsed-once stores are left alone. No database connection required.
 */

const mockSubFind = jest.fn();
const mockSubFindOne = jest.fn();
const mockSubSave = jest.fn().mockResolvedValue(true);
const mockPlanFindById = jest.fn();
const mockEventCreate = jest.fn().mockResolvedValue(true);
const mockInvalidateCache = jest.fn();

jest.mock('../src/models/StoreSubscription', () => ({
  find: mockSubFind,
  findOne: mockSubFindOne,
}));
jest.mock('../src/models/SubscriptionPlan', () => ({
  findById: mockPlanFindById,
  findOne: jest.fn(),
}));
jest.mock('../src/models/SubscriptionEvent', () => ({
  create: mockEventCreate,
}));
jest.mock('../src/services/feature_access_service', () => ({
  invalidateCache: mockInvalidateCache,
}));

const { checkSubscriptionExpirySweep } = require('../src/services/subscription_service');

function subDoc(overrides = {}) {
  return {
    _id: 'sub-1',
    storeId: 'store-1',
    planId: 'plan-1',
    status: 'trial',
    save: mockSubSave,
    ...overrides,
  };
}

describe('checkSubscriptionExpirySweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubSave.mockResolvedValue(true);
    mockPlanFindById.mockResolvedValue({ graceDays: 7 });
  });

  it('moves a lapsed trial subscription into grace_period', async () => {
    const doc = subDoc({ storeId: 'store-1', status: 'trial' });

    // First query (period-lapsed) returns one store; second query (grace-lapsed) returns none.
    mockSubFind
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ storeId: 'store-1' }]) }) })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    mockSubFindOne.mockResolvedValue(doc);

    const result = await checkSubscriptionExpirySweep();

    expect(doc.status).toBe('grace_period');
    expect(doc.gracePeriodEndsAt).toBeInstanceOf(Date);
    expect(mockSubSave).toHaveBeenCalled();
    expect(result.enteredGracePeriod).toEqual(['store-1']);
    expect(result.expired).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('expires a subscription whose grace period has lapsed', async () => {
    const doc = subDoc({ storeId: 'store-2', status: 'grace_period' });

    mockSubFind
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ storeId: 'store-2' }]) }) });
    mockSubFindOne.mockResolvedValue(doc);

    const result = await checkSubscriptionExpirySweep();

    expect(doc.status).toBe('expired');
    expect(mockSubSave).toHaveBeenCalled();
    expect(result.expired).toEqual(['store-2']);
    expect(result.enteredGracePeriod).toEqual([]);
  });

  it('does nothing when no subscriptions have lapsed', async () => {
    mockSubFind
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });

    const result = await checkSubscriptionExpirySweep();

    expect(result).toEqual({ enteredGracePeriod: [], expired: [], errors: [] });
    expect(mockSubSave).not.toHaveBeenCalled();
  });

  it('collects per-store errors without aborting the whole sweep', async () => {
    mockSubFind
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ storeId: 'store-err' }]) }) })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    mockSubFindOne.mockResolvedValue(null); // enterGracePeriod returns null for a missing sub, not a throw — simulate a throwing path instead
    mockSubFindOne.mockImplementationOnce(() => { throw new Error('DB timeout'); });

    const result = await checkSubscriptionExpirySweep();

    expect(result.errors).toEqual([{ storeId: 'store-err', error: 'DB timeout' }]);
    expect(result.enteredGracePeriod).toEqual([]);
  });

  it('the query for period-lapsed subscriptions excludes grace_period, expired, cancelled and admin_override', async () => {
    let capturedFilter;
    mockSubFind.mockImplementation((filter) => {
      capturedFilter = capturedFilter || filter;
      return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) };
    });

    await checkSubscriptionExpirySweep();

    expect(capturedFilter.status.$in).toEqual(['trial', 'active', 'grandfathered']);
    expect(capturedFilter.status.$in).not.toContain('admin_override');
  });
});
