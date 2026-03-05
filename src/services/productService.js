const Product = require('../models/Product');

async function getProductByBarcode(barcode) {
  return await Product.findOne({ barcode });
}

async function getProducts() {
  return await Product.find();
}

module.exports = { getProductByBarcode, getProducts };
