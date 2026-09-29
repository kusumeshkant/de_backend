/**
 * productService soft-delete lifecycle.
 *
 * Zero stock hides a product (isAvailable:false) instead of deleting it, and
 * every path that puts stock back — admin edit, bulk upload, re-creating the
 * barcode — re-lists it. Matches the order path in orderService.createOrder.
 * No database connection required — models are mocked.
 */

const mockFindByIdAndUpdate = jest.fn();
const mockFindByIdAndDelete = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockBulkWrite = jest.fn();
const mockSave = jest.fn();

jest.mock('../src/models/Product', () => {
  function Product(doc) {
    Object.assign(this, doc);
    this.save = () => mockSave(this);
  }
  Product.findByIdAndUpdate = mockFindByIdAndUpdate;
  Product.findByIdAndDelete = mockFindByIdAndDelete;
  Product.findOneAndUpdate = mockFindOneAndUpdate;
  Product.bulkWrite = mockBulkWrite;
  return Product;
});
jest.mock('../src/models/UploadLog', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/models/Store', () => ({
  findById: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'S' }) }),
}));

const { updateProduct, createProduct, bulkUpsertProducts } = require('../src/services/productService');

const PRODUCT_ID = 'product-1';
const STORE_ID = 'store-abc';

beforeEach(() => {
  jest.clearAllMocks();
  mockFindByIdAndUpdate.mockImplementation(async (id, update) => ({ _id: id, ...update }));
  mockSave.mockImplementation(async (doc) => doc);
  mockBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 1 });
});

describe('updateProduct — stock decides availability', () => {
  it('stock 0 marks the product unavailable and never deletes it', async () => {
    const result = await updateProduct(PRODUCT_ID, { stock: 0 });

    expect(mockFindByIdAndDelete).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      PRODUCT_ID,
      expect.objectContaining({ stock: 0, isAvailable: false }),
      { new: true }
    );
    expect(result).toEqual(expect.objectContaining({ _id: PRODUCT_ID, stock: 0, isAvailable: false }));
  });

  it('stock 0 wins over isAvailable:true sent in the same call', async () => {
    await updateProduct(PRODUCT_ID, { stock: 0, isAvailable: true });
    expect(mockFindByIdAndUpdate.mock.calls[0][1].isAvailable).toBe(false);
    expect(mockFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it('stock > 0 re-lists the product (isAvailable:true)', async () => {
    await updateProduct(PRODUCT_ID, { stock: 7 });
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      PRODUCT_ID,
      expect.objectContaining({ stock: 7, isAvailable: true }),
      { new: true }
    );
  });

  it('stock > 0 wins over isAvailable:false sent in the same call', async () => {
    await updateProduct(PRODUCT_ID, { stock: 3, isAvailable: false });
    expect(mockFindByIdAndUpdate.mock.calls[0][1].isAvailable).toBe(true);
  });

  it('leaves availability alone when stock is not part of the update', async () => {
    await updateProduct(PRODUCT_ID, { name: 'Renamed' });
    expect(mockFindByIdAndUpdate.mock.calls[0][1]).toEqual({ name: 'Renamed' });
  });

  it('still honours an explicit isAvailable when stock is not sent', async () => {
    await updateProduct(PRODUCT_ID, { isAvailable: false });
    expect(mockFindByIdAndUpdate.mock.calls[0][1]).toEqual({ isAvailable: false });
  });
});

describe('bulkUpsertProducts — restock re-lists soft-deleted products', () => {
  const setOf = (i) => mockBulkWrite.mock.calls[0][0][i].updateOne.update.$set;

  it('a row with stock > 0 sets isAvailable:true', async () => {
    await bulkUpsertProducts(STORE_ID, [{ barcode: 'B1', name: 'Tee', price: 100, stock: 4 }]);
    expect(setOf(0)).toEqual(expect.objectContaining({ stock: 4, isAvailable: true }));
  });

  it('a row with stock 0 does not touch isAvailable', async () => {
    await bulkUpsertProducts(STORE_ID, [{ barcode: 'B2', name: 'Tee', price: 100, stock: 0 }]);
    expect(setOf(0)).not.toHaveProperty('isAvailable');
  });

  it('a row with no stock column does not touch isAvailable', async () => {
    await bulkUpsertProducts(STORE_ID, [{ barcode: 'B3', name: 'Tee', price: 100 }]);
    expect(setOf(0).stock).toBe(0);
    expect(setOf(0)).not.toHaveProperty('isAvailable');
  });
});

describe('createProduct — a soft-deleted barcode is revived, not duplicated', () => {
  const INPUT = { storeId: STORE_ID, barcode: 'B-REVIVE', name: 'Kurta', price: 999, stock: 5 };

  it('revives the soft-deleted record instead of inserting (no E11000)', async () => {
    const revived = { _id: 'old-id', ...INPUT, isAvailable: true };
    mockFindOneAndUpdate.mockResolvedValueOnce(revived);

    const result = await createProduct(INPUT);

    expect(result).toBe(revived);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('only matches a soft-deleted record — an available duplicate still fails as before', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    await createProduct(INPUT);
    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual({
      barcode: 'B-REVIVE', storeId: STORE_ID, isAvailable: false,
    });
  });

  it('resets the record to what a fresh create would store', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({ _id: 'old-id' });
    await createProduct(INPUT);

    const [, update, options] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$set).toEqual(expect.objectContaining({
      barcode: 'B-REVIVE', name: 'Kurta', price: 999, mrp: 999, stock: 5,
      reorderLevel: 5, isAvailable: true,
    }));
    // Stale optional fields from the old record are cleared, not inherited.
    expect(Object.keys(update.$unset)).toEqual(
      expect.arrayContaining(['sku', 'description', 'brand', 'gender', 'color', 'imageUrl'])
    );
    expect(options).toEqual({ new: true, runValidators: true });
  });

  it('does not clear an optional field that was supplied', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({ _id: 'old-id' });
    await createProduct({ ...INPUT, brand: 'Fabindia' });
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$set.brand).toBe('Fabindia');
    expect(update.$unset).not.toHaveProperty('brand');
  });

  it('inserts a new product when there is nothing to revive', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    const result = await createProduct(INPUT);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ barcode: 'B-REVIVE', stock: 5 }));
  });

  it('propagates the duplicate-key error for an available product with the same barcode', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    mockSave.mockRejectedValueOnce(dup);
    await expect(createProduct(INPUT)).rejects.toMatchObject({ code: 11000 });
  });
});
