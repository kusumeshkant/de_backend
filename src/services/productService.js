const Product = require('../models/Product');

async function getProductByBarcode(barcode, storeId) {
  return await Product.findOne({ barcode, storeId });
}

async function getProducts() {
  return await Product.find();
}

module.exports = { getProductByBarcode, getProducts };
