const Order = require('../models/Order');
const Store = require('../models/Store');
const Product = require('../models/Product');
const CartCheckEvent = require('../models/CartCheckEvent');
const User = require('../models/User');
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

  // Mark the most recent cart check event for this user+store as converted (non-blocking)
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  CartCheckEvent.findOneAndUpdate(
    { userId, storeId, converted: false, createdAt: { $gte: sixtyMinutesAgo } },
    { converted: true, convertedOrderId: order._id },
    { sort: { createdAt: -1 } }
  ).catch(() => {});

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

  // Discount depth — per product and overall, only where mrp > 0 and mrp > price
  const discountMap = {};
  for (const order of completedOrders) {
    for (const item of order.items) {
      if (!item.mrp || item.mrp <= 0 || item.mrp <= item.price) continue;
      const depth = ((item.mrp - item.price) / item.mrp) * 100;
      const key   = item.barcode;
      if (!discountMap[key]) {
        discountMap[key] = { name: item.name, barcode: key, depths: [], totalSold: 0 };
      }
      discountMap[key].depths.push(depth);
      discountMap[key].totalSold += item.quantity ?? 1;
    }
  }

  const allDepths = Object.values(discountMap).flatMap((p) => p.depths);
  const avgDiscountDepth = allDepths.length > 0
    ? allDepths.reduce((s, d) => s + d, 0) / allDepths.length
    : null;

  const topDiscountedProducts = Object.values(discountMap)
    .map((p) => ({
      name:          p.name,
      barcode:       p.barcode,
      avgDiscount:   p.depths.reduce((s, d) => s + d, 0) / p.depths.length,
      totalSold:     p.totalSold,
    }))
    .sort((a, b) => b.avgDiscount - a.avgDiscount)
    .slice(0, 10);

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
    avgDiscountDepth,
    topDiscountedProducts,
  };
}

async function validateCartStock(storeId, items, userId = null) {
  const outOfStock = [];
  for (const item of items) {
    const product = await Product.findOne({ barcode: item.barcode, storeId });
    if (!product || !product.isAvailable || product.stock < (item.quantity ?? 1)) {
      outOfStock.push(item.name || item.barcode);
    }
  }

  // Log cart check event for abandonment tracking (non-blocking)
  if (userId) {
    const estimatedTotal = items.reduce((s, i) => s + (i.price ?? 0) * (i.quantity ?? 1), 0);
    CartCheckEvent.create({
      userId,
      storeId,
      itemCount: items.length,
      estimatedTotal,
    }).catch(() => {});
  }

  return outOfStock;
}

async function getBasketAbandonmentStats(storeId) {
  const filter = {};
  if (storeId) filter.storeId = storeId;

  const [total, converted] = await Promise.all([
    CartCheckEvent.countDocuments(filter),
    CartCheckEvent.countDocuments({ ...filter, converted: true }),
  ]);

  const abandoned        = total - converted;
  const abandonmentRate  = total > 0 ? (abandoned / total) * 100 : 0;
  const conversionRate   = total > 0 ? (converted / total) * 100 : 0;

  // This week vs last week abandonment
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  const [thisWeekTotal, thisWeekConverted, lastWeekTotal, lastWeekConverted] = await Promise.all([
    CartCheckEvent.countDocuments({ ...filter, createdAt: { $gte: startOfThisWeek } }),
    CartCheckEvent.countDocuments({ ...filter, converted: true, createdAt: { $gte: startOfThisWeek } }),
    CartCheckEvent.countDocuments({ ...filter, createdAt: { $gte: startOfLastWeek, $lt: startOfThisWeek } }),
    CartCheckEvent.countDocuments({ ...filter, converted: true, createdAt: { $gte: startOfLastWeek, $lt: startOfThisWeek } }),
  ]);

  const thisWeekAbandonmentRate = thisWeekTotal > 0
    ? ((thisWeekTotal - thisWeekConverted) / thisWeekTotal) * 100 : 0;
  const lastWeekAbandonmentRate = lastWeekTotal > 0
    ? ((lastWeekTotal - lastWeekConverted) / lastWeekTotal) * 100 : 0;

  return {
    totalChecks:           total,
    convertedChecks:       converted,
    abandonedChecks:       abandoned,
    abandonmentRate,
    conversionRate,
    thisWeekAbandonmentRate,
    lastWeekAbandonmentRate,
  };
}

async function getStaffPerformance(storeId) {
  const filter = {};
  if (storeId) filter.storeId = storeId;

  const orders = await Order.find(filter);

  // Build per-staff stats from staffActions audit trail
  const staffMap = {};

  for (const order of orders) {
    for (const action of (order.staffActions ?? [])) {
      const sid  = action.staffId;
      const name = action.staffName ?? 'Unknown';
      if (!sid) continue;

      if (!staffMap[sid]) {
        staffMap[sid] = {
          staffId:            sid,
          staffName:          name,
          ordersCompleted:    0,
          ordersCancelled:    0,
          flagsRaised:        0,
          totalOrdersHandled: new Set(),
          fulfillmentTimes:   [],
        };
      }

      staffMap[sid].totalOrdersHandled.add(order._id.toString());

      if (action.action === 'completed') {
        staffMap[sid].ordersCompleted += 1;
        // Fulfillment time for orders this staff completed
        if (order.completedAt && order.createdAt) {
          const mins = (order.completedAt - order.createdAt) / 1000 / 60;
          staffMap[sid].fulfillmentTimes.push(mins);
        }
      }
      if (action.action === 'cancelled')    staffMap[sid].ordersCancelled += 1;
      if (action.action === 'flagged_issue') staffMap[sid].flagsRaised    += 1;
    }
  }

  return Object.values(staffMap).map((s) => ({
    staffId:              s.staffId,
    staffName:            s.staffName,
    ordersCompleted:      s.ordersCompleted,
    ordersCancelled:      s.ordersCancelled,
    flagsRaised:          s.flagsRaised,
    totalOrdersHandled:   s.totalOrdersHandled.size,
    avgFulfillmentTime:   s.fulfillmentTimes.length > 0
      ? s.fulfillmentTimes.reduce((a, b) => a + b, 0) / s.fulfillmentTimes.length
      : null,
    cancellationRate:     s.totalOrdersHandled.size > 0
      ? (s.ordersCancelled / s.totalOrdersHandled.size) * 100
      : 0,
  })).sort((a, b) => b.ordersCompleted - a.ordersCompleted);
}

async function getCustomerRetention(storeId) {
  const filter = {};
  if (storeId) filter.storeId = storeId;

  // All orders sorted by user + createdAt
  const orders = await Order.find(filter).sort({ user: 1, createdAt: 1 });

  // Group orders by userId
  const userOrderMap = {};
  for (const order of orders) {
    const uid = order.user?.toString();
    if (!uid) continue;
    if (!userOrderMap[uid]) userOrderMap[uid] = [];
    userOrderMap[uid].push(order.createdAt);
  }

  const totalCustomers = Object.keys(userOrderMap).length;
  if (totalCustomers === 0) {
    return {
      totalCustomers: 0,
      returningCustomers: 0,
      retentionRate: 0,
      avgRepeatIntervalDays: null,
      newCustomersThisWeek: 0,
      newCustomersLastWeek: 0,
    };
  }

  // Returning = users with 2+ orders
  const returningUsers = Object.values(userOrderMap).filter((dates) => dates.length >= 2);
  const returningCustomers = returningUsers.length;
  const retentionRate = (returningCustomers / totalCustomers) * 100;

  // Avg days between 1st and 2nd order
  const intervals = returningUsers.map((dates) => {
    const first  = new Date(dates[0]);
    const second = new Date(dates[1]);
    return (second - first) / (1000 * 60 * 60 * 24); // ms → days
  });
  const avgRepeatIntervalDays = intervals.length > 0
    ? intervals.reduce((s, d) => s + d, 0) / intervals.length
    : null;

  // New customers this week vs last week (first order in that window)
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  let newCustomersThisWeek = 0;
  let newCustomersLastWeek = 0;
  for (const dates of Object.values(userOrderMap)) {
    const firstOrder = new Date(dates[0]);
    if (firstOrder >= startOfThisWeek) newCustomersThisWeek++;
    else if (firstOrder >= startOfLastWeek && firstOrder < startOfThisWeek) newCustomersLastWeek++;
  }

  return {
    totalCustomers,
    returningCustomers,
    retentionRate,
    avgRepeatIntervalDays,
    newCustomersThisWeek,
    newCustomersLastWeek,
  };
}

// ── Customer LTV Projection ───────────────────────────────────────────────────
async function getCustomerLTV(storeId) {
  const filter = { status: 'completed' };
  if (storeId) filter.storeId = storeId;

  const orders = await Order.find(filter).sort({ user: 1, createdAt: 1 });

  if (orders.length === 0) {
    return {
      totalCustomers: 0,
      avgRevenuePerCustomer: 0,
      avgOrdersPerCustomer: 0,
      avgDaysActive: null,
      projectedMonthlyLTV: null,
      topCustomers: [],
    };
  }

  // Group by userId
  const customerMap = {}; // uid → { revenue, orders: [Date], firstOrder, lastOrder }
  for (const order of orders) {
    const uid = order.user.toString();
    if (!customerMap[uid]) {
      customerMap[uid] = { revenue: 0, orderDates: [], userId: uid };
    }
    customerMap[uid].revenue += order.grandTotal || 0;
    customerMap[uid].orderDates.push(new Date(order.createdAt));
  }

  const customers = Object.values(customerMap);
  const totalCustomers = customers.length;

  const totalRevenue = customers.reduce((s, c) => s + c.revenue, 0);
  const totalOrderCount = customers.reduce((s, c) => s + c.orderDates.length, 0);

  const avgRevenuePerCustomer = totalRevenue / totalCustomers;
  const avgOrdersPerCustomer  = totalOrderCount / totalCustomers;

  // avgDaysActive: avg span (lastOrder - firstOrder) for customers with 2+ orders
  const returningCustomers = customers.filter((c) => c.orderDates.length >= 2);
  let avgDaysActive = null;
  if (returningCustomers.length > 0) {
    const spans = returningCustomers.map((c) => {
      const first = c.orderDates[0];
      const last  = c.orderDates[c.orderDates.length - 1];
      return (last - first) / (1000 * 60 * 60 * 24);
    });
    avgDaysActive = spans.reduce((s, d) => s + d, 0) / spans.length;
  }

  // projectedMonthlyLTV — only meaningful when we have avgDaysActive > 0
  const projectedMonthlyLTV =
    avgDaysActive && avgDaysActive > 0
      ? (avgRevenuePerCustomer / avgDaysActive) * 30
      : null;

  // Top 10 customers by revenue — look up names from User collection
  const sorted = customers.sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const userIds = sorted.map((c) => c.userId);
  const users   = await User.find({ _id: { $in: userIds } }).select('_id name phone');
  const userLookup = {};
  for (const u of users) userLookup[u._id.toString()] = u;

  const topCustomers = sorted.map((c) => {
    const u = userLookup[c.userId];
    return {
      userId:      c.userId,
      name:        u?.name  || 'Unknown',
      phone:       u?.phone || null,
      totalSpend:  c.revenue,
      totalOrders: c.orderDates.length,
    };
  });

  return {
    totalCustomers,
    avgRevenuePerCustomer,
    avgOrdersPerCustomer,
    avgDaysActive,
    projectedMonthlyLTV,
    topCustomers,
  };
}

// ── Monthly Revenue Export ────────────────────────────────────────────────────
async function getMonthlyRevenue(storeId, year) {
  const targetYear = year || new Date().getFullYear();
  const start = new Date(`${targetYear}-01-01T00:00:00.000Z`);
  const end   = new Date(`${targetYear + 1}-01-01T00:00:00.000Z`);

  const filter = { status: 'completed', createdAt: { $gte: start, $lt: end } };
  if (storeId) filter.storeId = storeId;

  const orders = await Order.find(filter).select('grandTotal createdAt');

  // Aggregate into month buckets (1–12)
  const buckets = {};
  for (let m = 1; m <= 12; m++) {
    buckets[m] = { month: m, year: targetYear, revenue: 0, orders: 0 };
  }

  for (const order of orders) {
    const month = new Date(order.createdAt).getUTCMonth() + 1;
    buckets[month].revenue += order.grandTotal || 0;
    buckets[month].orders  += 1;
  }

  return Object.values(buckets);
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
  getCustomerRetention,
  getStaffPerformance,
  getBasketAbandonmentStats,
  getCustomerLTV,
  getMonthlyRevenue,
};
