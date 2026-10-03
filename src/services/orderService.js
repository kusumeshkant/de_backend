const mongoose = require('mongoose');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Product = require('../models/Product');
const CartCheckEvent = require('../models/CartCheckEvent');
const User = require('../models/User');
const PendingPayment = require('../models/PendingPayment');
const { GraphQLError } = require('graphql');
const { sendNewOrderToStaff } = require('./notificationService_cf');
const { newExitCode } = require('./exitService');
const logger = require('../utils/logger_cf');

// Revenue = money taken and kept: paid and not cancelled, whether or not the
// customer has exited yet (decision 2, Task 6). Orders written before
// paymentStatus existed have no field and were paid, hence the null.
const REVENUE_FILTER = { paymentStatus: { $in: ['success', null] }, status: { $ne: 'cancelled' } };
const isRevenue = (o) => (o.paymentStatus ?? 'success') === 'success' && o.status !== 'cancelled';

const paymentError = (message, code) => new GraphQLError(message, { extensions: { code } });

// The order already created for this Razorpay order, if any — lets a retried
// createOrder return the same order instead of failing or duplicating it.
async function findOrderForPayment(razorpayOrderId, userId) {
  return Order.findOne({ razorpayOrderId, user: userId });
}

// The caller's unconsumed PendingPayment for this Razorpay order, or null.
// Records created before A3 have no status field; $in: [..., null] matches them.
async function getPendingForUser(razorpayOrderId, userId) {
  return PendingPayment.findOne({ razorpayOrderId, userId, status: { $in: ['pending', null] } });
}

// Line items and totals for the order, taken ONLY from the PendingPayment.
// Records created before A3 (in flight across the deploy) carry no total/tax
// and client-supplied items; they are honoured with totals derived from the
// server-charged amount so a customer who already paid still gets an order.
function _orderValuesFrom(pending) {
  const grandTotal = pending.serverTotal;
  if (typeof pending.total === 'number' && typeof pending.tax === 'number') {
    return { items: pending.items, total: pending.total, tax: pending.tax, discountAmount: pending.discountAmount ?? 0, grandTotal };
  }
  const grandPaise = Math.round(grandTotal * 100);
  const totalPaise = Math.round(grandPaise / 1.18);
  return { items: pending.items, total: totalPaise / 100, tax: (grandPaise - totalPaise) / 100, discountAmount: 0, grandTotal };
}

/**
 * Turns a verified Razorpay payment into an Order (A3).
 *
 * The caller must already have verified the payment signature. Everything in
 * the order — store, line items, total, tax, discount, grand total — comes from
 * the PendingPayment written by createRazorpayOrderFromCart. Nothing from the
 * client is used, and stock is decremented from that same item list.
 *
 * The PendingPayment is claimed atomically (pending → consumed), so concurrent
 * or repeated calls for one Razorpay order produce exactly one Order.
 */
async function createOrder({ userId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const pending = await PendingPayment.findOneAndUpdate(
    { razorpayOrderId, userId, status: { $in: ['pending', null] } },
    {
      $set: { status: 'consumed', razorpayPaymentId, consumedAt: new Date() },
      $unset: { expiresAt: 1 }, // keep the consumed record for audit (TTL skips it)
    },
    { new: true }
  );

  if (!pending) {
    // Retry of a payment that already became an order: return that order.
    const existing = await findOrderForPayment(razorpayOrderId, userId);
    if (existing) return existing;

    const other = await PendingPayment.findOne({ razorpayOrderId }).select('userId status');
    if (other && other.userId.toString() !== userId.toString()) {
      throw paymentError('Payment session does not belong to this account.', 'FORBIDDEN');
    }
    if (other && other.status === 'consumed') {
      // Another request claimed it and is still writing the order.
      throw paymentError('This payment is already being processed. Please check My Orders.', 'ORDER_IN_PROGRESS');
    }
    throw paymentError('Payment session not found or expired. Please restart checkout.', 'PAYMENT_SESSION_NOT_FOUND');
  }

  const storeId = pending.storeId;
  const { items, total, tax, discountAmount, grandTotal } = _orderValuesFrom(pending);

  const order = new Order({
    user: userId,
    storeId,
    items,
    total,
    tax,
    discountAmount,
    grandTotal,
    status: 'pending',
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    paymentStatus: 'success',
    exitCode: newExitCode(), // behind the customer's single-use exit QR
  });

  try {
    await order.save();
  } catch (err) {
    // Unique-index backstop: an order for this Razorpay order already exists.
    if (err?.code === 11000) {
      const existing = await findOrderForPayment(razorpayOrderId, userId);
      if (existing) return existing;
    }
    throw err;
  }
  // The discount code the payment was priced with — the resolver consumes this
  // one, never a code supplied by the client at createOrder time.
  order._discountCode = pending.discountCode ?? null;
  order._subtotal = pending.subtotal ?? null;

  // Mark the most recent cart check event for this user+store as converted (non-blocking)
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  CartCheckEvent.findOneAndUpdate(
    { userId, storeId, converted: false, createdAt: { $gte: sixtyMinutesAgo } },
    { converted: true, convertedOrderId: order._id },
    { sort: { createdAt: -1 } }
  ).catch(() => {});

  // Atomically decrement stock for each ordered item.
  // findOneAndUpdate with stock filter prevents overselling under concurrent orders.
  // On zero stock, soft-delete (isAvailable:false) instead of hard-deleting the document,
  // preserving the product record for audit trail and re-stock workflows.
  for (const item of items) {
    const qty = item.quantity ?? 1;
    const updated = await Product.findOneAndUpdate(
      { barcode: item.barcode, storeId, stock: { $gte: qty } },
      { $inc: { stock: -qty } },
      { new: true }
    );
    if (!updated) {
      // Stock was insufficient (concurrent order may have taken the last unit).
      // Order proceeds — payment already succeeded; staff resolves the discrepancy.
      logger.warn(`Stock insufficient during decrement: barcode=${item.barcode} storeId=${storeId} qty=${qty}`);
      continue;
    }
    if (updated.stock <= 0) {
      await Product.findByIdAndUpdate(updated._id, { isAvailable: false, stock: 0 });
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
  const orders = await Order.find({ user: userId }).sort({ createdAt: -1 }).limit(100);

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
  const orders = await Order.find({ storeId }).sort({ createdAt: -1 }).limit(500);

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

// Statuses each target may be reached from. 'completed' is deliberately absent:
// an order completes only through the exit (exitService.completeExit), which
// records who let the customer out and makes the exit QR single-use.
const ALLOWED_FROM = {
  preparing: ['pending'],
  ready: ['preparing'],
  cancelled: ['pending', 'preparing', 'ready'],
};

async function updateOrderStatus(orderId, status, staffId, staffName) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (status === 'completed') {
    throw new GraphQLError("Orders are completed at the exit: scan the customer's exit QR.", {
      extensions: { code: 'EXIT_REQUIRED' },
    });
  }
  const allowedFrom = ALLOWED_FROM[status];
  if (!allowedFrom) {
    throw new GraphQLError(`An order cannot be moved back to "${status}".`, { extensions: { code: 'INVALID_TRANSITION' } });
  }

  const action = STATUS_ACTION_MAP[status] || status;

  const timestampUpdate = {};
  if (status === 'cancelled') timestampUpdate.cancelledAt = new Date();

  // One atomic write: it only applies while the order is in an allowed status
  // and has not exited. Two concurrent cancels therefore cancel (and restock)
  // once, and an order that has left the store can no longer be cancelled.
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: { $in: allowedFrom }, exitedAt: null },
    {
      status,
      ...timestampUpdate,
      $push: {
        staffActions: { staffId, staffName, action, timestamp: new Date() },
      },
    },
    { new: true }
  );

  if (!order) {
    const current = await Order.findById(orderId).select('status exitedAt');
    if (!current) throw new Error('Order not found');
    const where = current.exitedAt ? 'it has already exited' : `it is ${current.status}`;
    throw new GraphQLError(`Cannot change this order to ${status}: ${where}.`, {
      extensions: { code: 'INVALID_TRANSITION' },
    });
  }

  // Restore stock when cancelling. The atomic filter above guarantees this
  // order was open until this request, so stock is restored exactly once.
  // Uses $set: { isAvailable: true } to un-soft-delete any product zeroed by this order.
  if (status === 'cancelled') {
    await Promise.all(
      (order.items || []).map(item => {
        const qty = item.quantity ?? 1;
        return Product.findOneAndUpdate(
          { barcode: item.barcode, storeId: order.storeId },
          { $inc: { stock: qty }, $set: { isAvailable: true } }
        ).catch(err => logger.warn(`Stock restore failed for barcode=${item.barcode}: ${err.message}`));
      })
    );
  }

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
  // Safety limit: load last 90 days of orders (max 5,000 rows).
  // At scale this should be replaced with MongoDB aggregation pipelines
  // to compute accurate lifetime totals without loading docs into memory.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const orders = await Order.find({ createdAt: { $gte: ninetyDaysAgo } }).sort({ createdAt: -1 }).limit(5000);
  const stores = await Store.find();

  const totalRevenue = orders
    .filter(isRevenue)
    .reduce((sum, o) => sum + (o.grandTotal ?? 0), 0);

  const totalOrders = orders.length;
  const pendingOrders = orders.filter((o) => ['pending', 'preparing', 'ready'].includes(o.status)).length;
  const completedOrders = orders.filter((o) => o.status === 'completed').length;
  const activeStores = stores.length;

  // Revenue per store
  const storeRevenueMap = {};
  const storeOrderCountMap = {};
  for (const o of orders.filter(isRevenue)) {
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
    .filter((o) => isRevenue(o) && o.createdAt >= startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const lastWeekRevenue = orders
    .filter((o) => isRevenue(o) && o.createdAt >= startOfLastWeek && o.createdAt < startOfThisWeek)
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
  // Safety limit: load most recent 1,000 orders. Totals are accurate up to 1,000 orders.
  // Replace with aggregation pipeline (Phase 12) for correct lifetime stats at scale.
  const orders = await Order.find({ storeId }).sort({ createdAt: -1 }).limit(1000);

  const revenueOrders = orders.filter(isRevenue);
  const totalRevenue = revenueOrders.reduce((sum, o) => sum + (o.grandTotal ?? 0), 0);

  const totalOrders = orders.length;
  const pendingOrders = orders.filter((o) => ['pending', 'preparing', 'ready'].includes(o.status)).length;
  const completedOrders = orders.filter((o) => o.status === 'completed').length;

  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
  const thisWeekRevenue = revenueOrders
    .filter((o) => o.createdAt >= startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const lastWeekRevenue = revenueOrders
    .filter((o) => o.createdAt >= startOfLastWeek && o.createdAt < startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);

  const recentOrders = orders.slice(0, 10).map((o) => {
    o._storeName = store?.name ?? null;
    o._storeCode = store?.storeCode ?? null;
    o._userId = o.user;
    return o;
  });

  return { store, totalRevenue, totalOrders, pendingOrders, completedOrders, recentOrders, thisWeekRevenue, lastWeekRevenue };
}

async function getStoreAnalytics(storeId) {
  const revenueFilter = { ...REVENUE_FILTER };
  const allFilter = {};
  if (storeId) {
    revenueFilter.storeId = storeId;
    allFilter.storeId = storeId;
  }

  // Revenue figures use paid, non-cancelled orders; fulfilment time and the
  // completed count still use exited ('completed') orders.
  const [paidOrders, allOrders] = await Promise.all([
    Order.find(revenueFilter).limit(5000),
    Order.find(allFilter).limit(5000),
  ]);
  const completedOrders = allOrders.filter((o) => o.status === 'completed');

  const totalRevenue = paidOrders.reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const totalOrders = allOrders.length;
  const cancelledOrders = allOrders.filter((o) => o.status === 'cancelled').length;
  const avgOrderValue = paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0;

  // Top products by revenue (from paid orders)
  const productMap = {};
  for (const order of paidOrders) {
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

  // Avg items per paid order
  const totalItemsAcrossOrders = paidOrders.reduce((s, o) => s + o.items.reduce((si, i) => si + (i.quantity ?? 1), 0), 0);
  const avgItemsPerOrder = paidOrders.length > 0 ? totalItemsAcrossOrders / paidOrders.length : 0;

  // Total units sold
  const totalUnitsSold = Object.values(productMap).reduce((s, p) => s + p.totalSold, 0);

  // Week-over-week comparison
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  const thisWeekRevenue = paidOrders
    .filter((o) => o.createdAt >= startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);
  const lastWeekRevenue = paidOrders
    .filter((o) => o.createdAt >= startOfLastWeek && o.createdAt < startOfThisWeek)
    .reduce((s, o) => s + (o.grandTotal ?? 0), 0);

  // Low stock count — products with stock <= 5
  const lowStockFilter = { stock: { $gt: 0, $lte: 5 } };
  if (storeId) lowStockFilter.storeId = storeId;
  const lowStockCount = await Product.countDocuments(lowStockFilter);

  // Daily revenue — last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentPaid = paidOrders.filter((o) => o.createdAt >= thirtyDaysAgo);

  const dailyMap = {};
  for (const order of recentPaid) {
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
    if (isRevenue(order)) hourMap[h].revenue += order.grandTotal ?? 0;
  }
  const peakHours = Object.values(hourMap);

  // Peak days — all orders grouped by day of week (0=Sun … 6=Sat)
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayMap = {};
  for (let d = 0; d < 7; d++) dayMap[d] = { day: DAY_NAMES[d], dayIndex: d, orders: 0, revenue: 0 };
  for (const order of allOrders) {
    const d = new Date(order.createdAt).getDay();
    dayMap[d].orders += 1;
    if (isRevenue(order)) dayMap[d].revenue += order.grandTotal ?? 0;
  }
  const peakDays = Object.values(dayMap);

  // Discount depth — per product and overall, only where mrp > 0 and mrp > price
  const discountMap = {};
  for (const order of paidOrders) {
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

  const orders = await Order.find(filter).limit(5000);

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

      if (['completed', 'exited', 'manual_exit'].includes(action.action)) {
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
  const orders = await Order.find(filter).sort({ user: 1, createdAt: 1 }).limit(5000);

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
  const filter = { ...REVENUE_FILTER };
  if (storeId) filter.storeId = storeId;

  const orders = await Order.find(filter).sort({ user: 1, createdAt: 1 }).limit(5000);

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

  const filter = { ...REVENUE_FILTER, createdAt: { $gte: start, $lt: end } };
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

// ── Cursor helpers ─────────────────────────────────────────────────────────────

function _encodeCursor(id, sortValue) {
  return Buffer.from(JSON.stringify({ id: id.toString(), v: sortValue?.toString() ?? '' })).toString('base64');
}

function _decodeCursor(cursor) {
  try { return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); } catch { return null; }
}

// ── Paginated orders ────────────────────────────────────────────────────────────

async function getOrdersPaginated({
  storeId = null,
  first = 30,
  after = null,
  search = null,
  sortBy = 'createdAt',
  sortDir = null,
  filters = {},
} = {}) {
  const VALID = new Set(['createdAt', 'grandTotal', '_id']);
  const sort  = VALID.has(sortBy) ? sortBy : 'createdAt';
  const dir   = sortDir === 'asc' ? 1 : -1;
  const limit = Math.min(Math.max(1, first || 30), 100);

  const baseFilter = {};
  if (storeId)         baseFilter.storeId = storeId;
  if (filters.status)  baseFilter.status  = filters.status;
  if (search)          baseFilter.$or = [{ storeName: { $regex: search, $options: 'i' } }];

  const decoded = after ? _decodeCursor(after) : null;
  let cursorFilter = {};
  if (decoded) {
    const oid = mongoose.Types.ObjectId.createFromHexString(decoded.id);
    if (sort === '_id') {
      cursorFilter = dir === 1 ? { _id: { $gt: oid } } : { _id: { $lt: oid } };
    } else {
      const op = dir === 1 ? '$gt' : '$lt';
      const sortVal = sort === 'grandTotal' ? parseFloat(decoded.v)
                    : sort === 'createdAt'  ? new Date(decoded.v)
                    : decoded.v;
      cursorFilter = { $or: [
        { [sort]: { [op]: sortVal } },
        { [sort]: sortVal, _id: { [op]: oid } },
      ]};
    }
  }

  const storeScope = storeId ? { storeId } : {};
  const [rows, activeCount, completedCount, cancelledCount] = await Promise.all([
    Order.find({ ...baseFilter, ...cursorFilter })
      .sort(sort === '_id' ? { _id: dir } : { [sort]: dir, _id: dir })
      .limit(limit + 1)
      .select('storeId storeName storeCode total tax grandTotal status paymentStatus createdAt items staffActions flaggedIssue'),
    Order.countDocuments({ ...storeScope, status: { $in: ['pending', 'preparing', 'ready'] } }),
    Order.countDocuments({ ...storeScope, status: 'completed' }),
    Order.countDocuments({ ...storeScope, status: 'cancelled' }),
  ]);

  const hasNext = rows.length > limit;
  if (hasNext) rows.pop();
  const lastRow   = rows[rows.length - 1];
  const nextCursor = hasNext && lastRow
    ? _encodeCursor(lastRow._id, sort === '_id' ? null : lastRow[sort])
    : null;

  return {
    items: rows,
    meta: { hasNext, nextCursor, totalCount: activeCount + completedCount + cancelledCount },
    activeCount,
    completedCount,
    cancelledCount,
  };
}

module.exports = {
  REVENUE_FILTER,
  isRevenue,
  createOrder,
  findOrderForPayment,
  getPendingForUser,
  getMyOrders,
  getOrderById,
  getStoreOrders,
  getOrderByIdForStaff,
  updateOrderStatus,
  flagOrderIssue,
  getAllOrders,
  getOrdersPaginated,
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
