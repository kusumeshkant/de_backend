const Order = require('../models/Order');
const Store = require('../models/Store');
const { ErrorHandler } = require('../utils/errorHandler');

async function createOrder({ userId, storeId, items, total, tax, grandTotal }) {
  if (!items || items.length === 0) {
    throw new ErrorHandler('Cart is empty', 400);
  }

  const order = new Order({
    user: userId,
    storeId,
    items,
    total,
    tax,
    grandTotal,
    status: 'pending',
  });

  await order.save();

  // Attach storeName for immediate response
  const store = await Store.findById(storeId);
  order._storeName = store?.name ?? null;

  return order;
}

async function getMyOrders(userId) {
  const orders = await Order.find({ user: userId }).sort({ createdAt: -1 });

  // Attach store names in one query
  const storeIds = [...new Set(orders.map((o) => o.storeId?.toString()).filter(Boolean))];
  const stores = await Store.find({ _id: { $in: storeIds } });
  const storeMap = Object.fromEntries(stores.map((s) => [s._id.toString(), s.name]));

  return orders.map((o) => {
    o._storeName = storeMap[o.storeId?.toString()] ?? null;
    return o;
  });
}

async function getOrderById(orderId, userId) {
  const order = await Order.findOne({ _id: orderId, user: userId });
  if (!order) return null;

  const store = await Store.findById(order.storeId);
  order._storeName = store?.name ?? null;

  return order;
}

module.exports = { createOrder, getMyOrders, getOrderById };
