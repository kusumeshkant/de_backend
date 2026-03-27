const Order = require('../models/Order');
const Store = require('../models/Store');
const Product = require('../models/Product');
const { ErrorHandler } = require('../utils/errorHandler');
const { sendNewOrderToStaff } = require('./notificationService');

async function createOrder({ userId, storeId, items, total, tax, grandTotal, razorpayOrderId, razorpayPaymentId }) {
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
    razorpayOrderId,
    razorpayPaymentId,
    paymentStatus: 'success',
  });

  await order.save();

  // Decrement stock for each ordered item
  for (const item of items) {
    const product = await Product.findOne({ barcode: item.barcode, storeId });
    if (!product) continue;

    const newStock = Math.max(0, product.stock - (item.quantity ?? 1));
    const update = { stock: newStock };
    if (newStock === 0) update.isAvailable = false;

    await Product.findByIdAndUpdate(product._id, update);
  }

  // Attach storeName for immediate response
  const store = await Store.findById(storeId);
  order._storeName = store?.name ?? null;
  order._storeCode = store?.storeCode ?? null;

  // Notify all staff of this store (non-blocking)
  sendNewOrderToStaff(storeId, {
    orderId: order._id,
    storeName: store?.name ?? null,
    itemCount: items.length,
    grandTotal,
  }).catch(() => {});

  return order;
}

async function getMyOrders(userId) {
  const orders = await Order.find({ user: userId }).sort({ createdAt: -1 });

  // Attach store names in one query
  const storeIds = [...new Set(orders.map((o) => o.storeId?.toString()).filter(Boolean))];
  const stores = await Store.find({ _id: { $in: storeIds } });
  const storeMap = Object.fromEntries(stores.map((s) => [s._id.toString(), s]));

  return orders.map((o) => {
    const store = storeMap[o.storeId?.toString()];
    o._storeName = store?.name ?? null;
    o._storeCode = store?.storeCode ?? null;
    return o;
  });
}

async function getOrderById(orderId, userId) {
  const order = await Order.findOne({ _id: orderId, user: userId });
  if (!order) return null;

  const store = await Store.findById(order.storeId);
  order._storeName = store?.name ?? null;
  order._storeCode = store?.storeCode ?? null;

  return order;
}

async function getStoreOrders(storeId) {
  const orders = await Order.find({ storeId }).sort({ createdAt: -1 });

  const store = await Store.findById(storeId);
  const storeName = store?.name ?? null;
  const storeCode = store?.storeCode ?? null;

  return orders.map((o) => {
    o._storeName = storeName;
    o._storeCode = storeCode;
    o._userId = o.user;
    return o;
  });
}

async function getOrderByIdForStaff(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;

  const store = await Store.findById(order.storeId);
  order._storeName = store?.name ?? null;
  order._storeCode = store?.storeCode ?? null;
  order._userId = order.user;

  return order;
}

const VALID_STATUSES = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];

const STATUS_ACTION_MAP = {
  preparing: 'started_preparing',
  ready: 'marked_ready',
  completed: 'completed',
  cancelled: 'cancelled',
};

async function updateOrderStatus(orderId, status, staffId, staffName) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const action = STATUS_ACTION_MAP[status] || status;

  const order = await Order.findByIdAndUpdate(
    orderId,
    {
      status,
      $push: {
        staffActions: { staffId, staffName, action, timestamp: new Date() },
      },
    },
    { new: true }
  );

  if (!order) throw new Error('Order not found');

  const store = await Store.findById(order.storeId);
  order._storeName = store?.name ?? null;
  order._storeCode = store?.storeCode ?? null;
  order._userId = order.user;

  return order;
}

async function flagOrderIssue(orderId, reason, note, staffId, staffName) {
  const order = await Order.findByIdAndUpdate(
    orderId,
    {
      flaggedIssue: { reason, note, staffId, staffName, timestamp: new Date() },
      $push: {
        staffActions: {
          staffId,
          staffName,
          action: 'flagged_issue',
          note: note ? `${reason}: ${note}` : reason,
          timestamp: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!order) throw new Error('Order not found');

  const store = await Store.findById(order.storeId);
  order._storeName = store?.name ?? null;
  order._storeCode = store?.storeCode ?? null;
  order._userId = order.user;

  return order;
}

async function getAllOrders({ storeId, status } = {}) {
  const filter = {};
  if (storeId) filter.storeId = storeId;
  if (status) filter.status = status;

  const orders = await Order.find(filter).sort({ createdAt: -1 });

  const storeIds = [...new Set(orders.map((o) => o.storeId?.toString()).filter(Boolean))];
  const stores = await Store.find({ _id: { $in: storeIds } });
  const storeMap = Object.fromEntries(stores.map((s) => [s._id.toString(), s]));

  return orders.map((o) => {
    const store = storeMap[o.storeId?.toString()];
    o._storeName = store?.name ?? null;
    o._storeCode = store?.storeCode ?? null;
    o._userId = o.user;
    return o;
  });
}

async function getDashboardStats() {
  const orders = await Order.find();
  const stores = await Store.find();

  const totalRevenue = orders
    .filter((o) => o.status === 'completed')
    .reduce((sum, o) => sum + (o.grandTotal ?? 0), 0);

  const totalOrders = orders.length;
  const pendingOrders = orders.filter((o) => ['pending', 'preparing', 'ready'].includes(o.status)).length;
  const completedOrders = orders.filter((o) => o.status === 'completed').length;
  const activeStores = stores.length;

  // Revenue per store
  const storeRevenueMap = {};
  const storeOrderCountMap = {};
  for (const o of orders.filter((o) => o.status === 'completed')) {
    const sid = o.storeId?.toString();
    if (!sid) continue;
    storeRevenueMap[sid] = (storeRevenueMap[sid] ?? 0) + (o.grandTotal ?? 0);
    storeOrderCountMap[sid] = (storeOrderCountMap[sid] ?? 0) + 1;
  }

  const storeMap = Object.fromEntries(stores.map((s) => [s._id.toString(), s]));
  const topStores = Object.entries(storeRevenueMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([sid, revenue]) => ({
      store: storeMap[sid] ?? null,
      revenue,
      orderCount: storeOrderCountMap[sid] ?? 0,
    }));

  // Recent orders (last 10)
  const recentOrders = orders
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map((o) => {
      o._storeName = storeMap[o.storeId?.toString()]?.name ?? null;
      o._storeCode = storeMap[o.storeId?.toString()]?.storeCode ?? null;
      o._userId = o.user;
      return o;
    });

  return { totalRevenue, totalOrders, pendingOrders, completedOrders, activeStores, topStores, recentOrders };
}

async function getStoreStats(storeId) {
  const store = await Store.findById(storeId);
  const orders = await Order.find({ storeId }).sort({ createdAt: -1 });

  const totalRevenue = orders
    .filter((o) => o.status === 'completed')
    .reduce((sum, o) => sum + (o.grandTotal ?? 0), 0);

  const totalOrders = orders.length;
  const pendingOrders = orders.filter((o) => ['pending', 'preparing', 'ready'].includes(o.status)).length;
  const completedOrders = orders.filter((o) => o.status === 'completed').length;

  const recentOrders = orders.slice(0, 10).map((o) => {
    o._storeName = store?.name ?? null;
    o._storeCode = store?.storeCode ?? null;
    o._userId = o.user;
    return o;
  });

  return { store, totalRevenue, totalOrders, pendingOrders, completedOrders, recentOrders };
}

module.exports = {
  createOrder,
  getMyOrders,
  getOrderById,
  getStoreOrders,
  getOrderByIdForStaff,
  updateOrderStatus,
  flagOrderIssue,
  getAllOrders,
  getDashboardStats,
  getStoreStats,
};
