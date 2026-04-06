const Order = require('../models/Order');
const Store = require('../models/Store');
const Product = require('../models/Product');
const { ErrorHandler } = require('../utils/errorHandler');
const { sendNewOrderToStaff } = require('./notificationService_cf');

async function createOrder({ userId, storeId, items, total, tax, grandTotal, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
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
    razorpaySignature,
    paymentStatus: 'success',
  });

  await order.save();

  // Decrement stock for each ordered item
  for (const item of items) {
    const product = await Product.findOne({ barcode: item.barcode, storeId });
    if (!product) continue;

    const newStock = Math.max(0, product.stock - (item.quantity ?? 1));
    if (newStock === 0) {
      await Product.findByIdAndDelete(product._id);
    } else {
      await Product.findByIdAndUpdate(product._id, { stock: newStock });
    }
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

  const timestampUpdate = {};
  if (status === 'completed') timestampUpdate.completedAt = new Date();
  if (status === 'cancelled') timestampUpdate.cancelledAt = new Date();

  const order = await Order.findByIdAndUpdate(
    orderId,
    {
      status,
      ...timestampUpdate,
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

  // Week-over-week order growth
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  const thisWeekOrders = orders.filter((o) => o.createdAt >= startOfThisWeek).length;
  const lastWeekOrders = orders.filter((o) => o.createdAt >= startOfLastWeek && o.createdAt < startOfThisWeek).length;
  const orderGrowthRate = lastWeekOrders > 0
    ? ((thisWeekOrders - lastWeekOrders) / lastWeekOrders) * 100
    : null;

  // Week-over-week revenue growth (platform level)
  const thisWeekRevenue = orders
    .filter((o) => o.status === 'completed' && o.createdAt >= startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const lastWeekRevenue = orders
    .filter((o) => o.status === 'completed' && o.createdAt >= startOfLastWeek && o.createdAt < startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const revenueGrowthRate = lastWeekRevenue > 0
    ? ((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue) * 100
    : null;

  return {
    totalRevenue,
    totalOrders,
    pendingOrders,
    completedOrders,
    activeStores,
    topStores,
    recentOrders,
    thisWeekOrders,
    lastWeekOrders,
    orderGrowthRate,
    thisWeekRevenue,
    lastWeekRevenue,
    revenueGrowthRate,
  };
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

async function getStoreAnalytics(storeId) {
  const completedFilter = { status: 'completed' };
  const allFilter = {};
  if (storeId) {
    completedFilter.storeId = storeId;
    allFilter.storeId = storeId;
  }

  const [completedOrders, allOrders] = await Promise.all([
    Order.find(completedFilter),
    Order.find(allFilter),
  ]);

  const totalRevenue = completedOrders.reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const totalOrders = allOrders.length;
  const cancelledOrders = allOrders.filter((o) => o.status === 'cancelled').length;
  const avgOrderValue = completedOrders.length > 0 ? totalRevenue / completedOrders.length : 0;

  // Top products by revenue (from completed orders)
  const productMap = {};
  for (const order of completedOrders) {
    for (const item of order.items) {
      if (!productMap[item.barcode]) {
        productMap[item.barcode] = { name: item.name, barcode: item.barcode, totalSold: 0, revenue: 0 };
      }
      productMap[item.barcode].totalSold += item.quantity ?? 1;
      productMap[item.barcode].revenue += (item.price ?? 0) * (item.quantity ?? 1);
    }
  }
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // Avg items per completed order
  const totalItemsAcrossOrders = completedOrders.reduce((s, o) => s + o.items.reduce((si, i) => si + (i.quantity ?? 1), 0), 0);
  const avgItemsPerOrder = completedOrders.length > 0 ? totalItemsAcrossOrders / completedOrders.length : 0;

  // Total units sold
  const totalUnitsSold = Object.values(productMap).reduce((s, p) => s + p.totalSold, 0);

  // Week-over-week comparison
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  const thisWeekRevenue = completedOrders
    .filter((o) => o.createdAt >= startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const lastWeekRevenue = completedOrders
    .filter((o) => o.createdAt >= startOfLastWeek && o.createdAt < startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);

  // Low stock count — products with stock <= 5
  const lowStockFilter = { stock: { $gt: 0, $lte: 5 } };
  if (storeId) lowStockFilter.storeId = storeId;
  const lowStockCount = await Product.countDocuments(lowStockFilter);

  // Daily revenue — last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentCompleted = completedOrders.filter((o) => o.createdAt >= thirtyDaysAgo);

  const dailyMap = {};
  for (const order of recentCompleted) {
    const date = order.createdAt.toISOString().slice(0, 10);
    if (!dailyMap[date]) dailyMap[date] = { date, revenue: 0, orders: 0 };
    dailyMap[date].revenue += order.grandTotal ?? 0;
    dailyMap[date].orders += 1;
  }
  const dailyRevenue = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // Peak hours — all orders grouped by hour of day (0–23)
  const hourMap = {};
  for (let h = 0; h < 24; h++) hourMap[h] = { hour: h, orders: 0, revenue: 0 };
  for (const order of allOrders) {
    const h = new Date(order.createdAt).getHours();
    hourMap[h].orders += 1;
    if (order.status === 'completed') hourMap[h].revenue += order.grandTotal ?? 0;
  }
  const peakHours = Object.values(hourMap);

  // Peak days — all orders grouped by day of week (0=Sun … 6=Sat)
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayMap = {};
  for (let d = 0; d < 7; d++) dayMap[d] = { day: DAY_NAMES[d], dayIndex: d, orders: 0, revenue: 0 };
  for (const order of allOrders) {
    const d = new Date(order.createdAt).getDay();
    dayMap[d].orders += 1;
    if (order.status === 'completed') dayMap[d].revenue += order.grandTotal ?? 0;
  }
  const peakDays = Object.values(dayMap);

  // Avg fulfillment time — orders that have both createdAt and completedAt
  const ordersWithFulfillment = completedOrders.filter((o) => o.completedAt && o.createdAt);
  const avgFulfillmentTime = ordersWithFulfillment.length > 0
    ? ordersWithFulfillment.reduce((s, o) => s + (o.completedAt - o.createdAt), 0)
      / ordersWithFulfillment.length
      / 1000 / 60  // ms → minutes
    : null;

  // Avg fulfillment time — today only
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayFulfilled = ordersWithFulfillment.filter((o) => o.completedAt >= startOfToday);
  const avgFulfillmentTimeToday = todayFulfilled.length > 0
    ? todayFulfilled.reduce((s, o) => s + (o.completedAt - o.createdAt), 0)
      / todayFulfilled.length
      / 1000 / 60
    : null;

  return {
    totalRevenue,
    totalOrders,
    completedOrders: completedOrders.length,
    cancelledOrders,
    avgOrderValue,
    avgItemsPerOrder,
    totalUnitsSold,
    thisWeekRevenue,
    lastWeekRevenue,
    lowStockCount,
    topProducts,
    dailyRevenue,
    avgFulfillmentTime,
    avgFulfillmentTimeToday,
    peakHours,
    peakDays,
  };
}

async function validateCartStock(storeId, items) {
  const outOfStock = [];
  for (const item of items) {
    const product = await Product.findOne({ barcode: item.barcode, storeId });
    if (!product || !product.isAvailable || product.stock < (item.quantity ?? 1)) {
      outOfStock.push(item.name || item.barcode);
    }
  }
  return outOfStock;
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
  validateCartStock,
  getStoreAnalytics,
};
