const Product = require('../models/Product');

async function getProductByBarcode(barcode, storeId) {
  return await Product.findOne({ barcode, storeId });
}

async function getProducts() {
  return await Product.find();
}

async function getStoreProducts(storeId) {
  return await Product.find({ storeId }).sort({ name: 1 });
}

async function createProduct({ storeId, barcode, name, description, price, stock }) {
  const product = new Product({ storeId, barcode, name, description, price, stock });
  return await product.save();
}

async function updateProduct(id, { name, description, price, stock }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (price !== undefined) update.price = price;
  if (stock !== undefined) update.stock = stock;
  return await Product.findByIdAndUpdate(id, update, { new: true });
}

async function deleteProduct(id) {
  const result = await Product.findByIdAndDelete(id);
  return !!result;
}

module.exports = { getProductByBarcode, getProducts, getStoreProducts, createProduct, updateProduct, deleteProduct };
