const Order = require('../models/Order');
const Product = require('../models/Product');
const { ErrorHandler } = require('../utils/errorHandler');

const createOrder = async ({ userId, products }) => {
  const productList = await Product.find({ _id: { $in: products } });
  if (productList.length === 0) {
    throw new ErrorHandler('No products found', 404);
  }
  const total = productList.reduce((sum, product) => sum + product.price, 0);
  const order = new Order({
    user: userId,
    products: productList,
    total,
    createdAt: new Date().toISOString(),
  });
  await order.save();
  return order;
};

const getOrders = async () => {
  return await Order.find().populate('user').populate('products');
};

module.exports = {
  createOrder,
  getOrders,
};