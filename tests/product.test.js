/**
 * productService unit tests.
 * Verifies the isAvailable filter on barcode scans (P0-04b fix).
 * No database connection required — Product model is mocked.
 */

const mockFindOne = jest.fn();
jest.mock('../src/models/Product', () => ({
  findOne: mockFindOne,
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { getProductByBarcode } = require('../src/services/productService');

describe('productService.getProductByBarcode', () => {
  const BARCODE = 'BARCODE-123';
  const STORE_ID = 'store-abc';

  beforeEach(() => {
    mockFindOne.mockReset();
  });

  it('queries with isAvailable: { $ne: false } to exclude soft-deleted products', async () => {
    mockFindOne.mockResolvedValue(null);
    await getProductByBarcode(BARCODE, STORE_ID);

    expect(mockFindOne).toHaveBeenCalledWith({
      barcode: BARCODE,
      storeId: STORE_ID,
      isAvailable: { $ne: false },
    });
  });

  it('returns product when found and available', async () => {
    const product = { _id: '1', barcode: BARCODE, storeId: STORE_ID, isAvailable: true, stock: 5 };
    mockFindOne.mockResolvedValue(product);

    const result = await getProductByBarcode(BARCODE, STORE_ID);
    expect(result).toEqual(product);
  });

  it('returns null when product is sold out (isAvailable: false)', async () => {
    // In this case MongoDB returns null because the filter excludes isAvailable:false
    mockFindOne.mockResolvedValue(null);

    const result = await getProductByBarcode(BARCODE, STORE_ID);
    expect(result).toBeNull();
  });

  it('returns null when product does not exist', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await getProductByBarcode('NONEXISTENT', STORE_ID);
    expect(result).toBeNull();
  });
});
