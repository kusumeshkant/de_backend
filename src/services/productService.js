const Product = require('../models/Product');
const { ErrorHandler } = require('../utils/errorHandler');

const addProduct = async ({ name, description, price, stock }) => {
  const product = new Product({ name, description, price, stock });
  await product.save();
  return product;
};

const getProducts = async () => {
  return await Product.find();
};

module.exports = {
  addProduct,
  getProducts,
};