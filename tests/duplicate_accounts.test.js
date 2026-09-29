/**
 * getOrCreateUser / updateProfile duplicate-email protection.
 *
 * Root cause these guard against: a Firebase account is deleted without its
 * MongoDB document, leaving an orphan that still holds the email. The next
 * signup gets a new firebase_uid, the uid lookup misses, and a SECOND document
 * is created with the same email. See DQ_DUPLICATE_ACCOUNTS_REVIEW.md.
 */

const mockFindOne = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockSave = jest.fn();

jest.mock('../src/models/User', () => {
  function User(doc) {
    Object.assign(this, doc);
    this.save = mockSave;
  }
  User.findOne = mockFindOne;
  User.findByIdAndUpdate = mockFindByIdAndUpdate;
  return User;
});

const {
  normalizeEmail,
  getOrCreateUser,
  updateProfile,
  getUserByEmail,
} = require('../src/services/userService');

const EXISTING = {
  _id: { toString: () => 'existing-mongo-id' },
  firebase_uid: 'OLD-uid-deleted-from-firebase',
  email: 'someone@example.com',
  roles: ['customer', 'admin'],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockResolvedValue(undefined);
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Someone@Example.COM ')).toBe('someone@example.com');
  });
  it('passes through null/undefined untouched', () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeUndefined();
  });
});

describe('getOrCreateUser — existing user by uid', () => {
  it('returns the existing document without any email lookup', async () => {
    mockFindOne.mockResolvedValueOnce({ _id: 'u1', firebase_uid: 'uid-1' });
    const user = await getOrCreateUser({ uid: 'uid-1', email: 'a@b.com' });
    expect(user.firebase_uid).toBe('uid-1');
    expect(mockFindOne).toHaveBeenCalledTimes(1); // uid lookup only
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('getOrCreateUser — genuinely new email', () => {
  it('creates the document', async () => {
    mockFindOne
      .mockResolvedValueOnce(null)  // by uid
      .mockResolvedValueOnce(null); // by email
    const user = await getOrCreateUser({ uid: 'uid-new', email: 'fresh@example.com', phone: '123' });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(user.firebase_uid).toBe('uid-new');
    expect(user.roles).toEqual(['customer']);
  });

  it('stores the email normalized', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const user = await getOrCreateUser({ uid: 'uid-new', email: '  Fresh@EXAMPLE.com ' });
    expect(user.email).toBe('fresh@example.com');
  });

  it('looks up by the normalized email, not the raw input', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await getOrCreateUser({ uid: 'uid-new', email: 'MiXeD@Example.COM' });
    expect(mockFindOne).toHaveBeenNthCalledWith(2, {
      email: 'mixed@example.com',
      firebase_uid: { $ne: 'uid-new' },
    });
  });

  it('creates without an email lookup when no email is supplied (phone auth)', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    const user = await getOrCreateUser({ uid: 'uid-phone', phone: '9999' });
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(user.phone).toBe('9999');
  });
});

describe('getOrCreateUser — email already held by a different uid', () => {
  it('throws EMAIL_ALREADY_LINKED instead of creating a duplicate', async () => {
    mockFindOne
      .mockResolvedValueOnce(null)      // by uid — the orphan is not found
      .mockResolvedValueOnce(EXISTING); // by email — the orphan IS found

    await expect(
      getOrCreateUser({ uid: 'NEW-uid-after-resignup', email: 'someone@example.com' })
    ).rejects.toThrow('This email is already linked to another account');

    expect(mockSave).not.toHaveBeenCalled(); // the duplicate was never written
  });

  it('does NOT re-point the existing document at the new uid (takeover guard)', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING);
    await expect(
      getOrCreateUser({ uid: 'ATTACKER-uid', email: 'someone@example.com' })
    ).rejects.toThrow();
    // No mutation of the existing record by any path.
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('carries diagnostic detail for the operator', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING);
    try {
      await getOrCreateUser({ uid: 'NEW-uid', email: 'someone@example.com' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.extensions.code).toBe('EMAIL_ALREADY_LINKED');
      expect(err.extensions.email).toBe('someone@example.com');
      expect(err.extensions.existingUserId).toBe('existing-mongo-id');
      expect(err.extensions.existingFirebaseUid).toBe('OLD-uid-deleted-from-firebase');
      expect(err.extensions.attemptedFirebaseUid).toBe('NEW-uid');
    }
  });

  it('treats a case variant of the same email as the same account', async () => {
    mockFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(EXISTING);

    await expect(
      getOrCreateUser({ uid: 'NEW-uid', email: 'SoMeOne@Example.COM' })
    ).rejects.toThrow('already linked');

    expect(mockFindOne).toHaveBeenNthCalledWith(2, {
      email: 'someone@example.com',
      firebase_uid: { $ne: 'NEW-uid' },
    });
  });
});

describe('updateProfile — same duplicate vector, different entry point', () => {
  it('rejects taking an email another account already holds', async () => {
    mockFindOne.mockResolvedValueOnce(EXISTING);
    await expect(
      updateProfile('my-id', { email: 'someone@example.com' })
    ).rejects.toThrow('That email is already in use');
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('allows keeping your own email (excludes self by _id)', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    mockFindByIdAndUpdate.mockResolvedValueOnce({ _id: 'my-id' });
    await updateProfile('my-id', { email: 'Mine@Example.com' });
    expect(mockFindOne).toHaveBeenCalledWith({
      email: 'mine@example.com',
      _id: { $ne: 'my-id' },
    });
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'my-id', { email: 'mine@example.com' }, { new: true }
    );
  });

  it('does not touch email when the field is not supplied', async () => {
    mockFindByIdAndUpdate.mockResolvedValueOnce({ _id: 'my-id' });
    await updateProfile('my-id', { name: 'New Name' });
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('my-id', { name: 'New Name' }, { new: true });
  });
});

describe('getUserByEmail', () => {
  it('normalizes before querying', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    await getUserByEmail('  Admin@Store.COM ');
    expect(mockFindOne).toHaveBeenCalledWith({ email: 'admin@store.com' });
  });
});
