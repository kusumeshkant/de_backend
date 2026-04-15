const admin = require('firebase-admin');
const logger = require('../utils/logger');

/**
 * Sends a push notification to a single device via FCM.
 * Silently ignores missing or invalid tokens.
 */
async function sendNotification(fcmToken, { title, body, data = {} }) {
  if (!fcmToken) return;

  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'dq_orders',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
    logger.info(`Push notification sent: "${title}"`);
  } catch (error) {
    // Invalid / expired token — log but don't fail the request
    logger.warn(`FCM send failed: ${error.message}`);
  }
}

/**
 * Sends an order confirmation notification to the user.
 */
async function sendOrderConfirmation(fcmToken, { grandTotal, storeName }) {
  const store = storeName ? `at ${storeName}` : '';
  await sendNotification(fcmToken, {
    title: 'Order Placed!',
    body: `Your order of ₹${Math.round(grandTotal)} ${store} has been confirmed.`,
    data: { type: 'order_confirmed' },
  });
}

const STATUS_MESSAGES = {
  preparing: {
    title: 'Order Being Prepared 🍽️',
    body: (store) => `Your order ${store} is now being prepared.`,
  },
  ready: {
    title: 'Order Ready for Pickup! ✅',
    body: (store) => `Your order ${store} is ready. Please proceed to collect it.`,
  },
  completed: {
    title: 'Order Completed 🎉',
    body: (store) => `Your order ${store} has been completed. Thank you!`,
  },
  cancelled: {
    title: 'Order Cancelled ❌',
    body: (store) => `Your order ${store} has been cancelled.`,
  },
};

/**
 * Sends a push notification when store staff updates order status.
 */
async function sendOrderStatusUpdate(fcmToken, { status, storeName }) {
  const template = STATUS_MESSAGES[status];
  if (!template) return; // 'pending' — no notification needed

  const store = storeName ? `at ${storeName}` : '';
  await sendNotification(fcmToken, {
    title: template.title,
    body: template.body(store),
    data: { type: 'order_status_update', status },
  });
}

/**
 * Sends a new order notification to all staff/admin of a store.
 */
async function sendNewOrderToStaff(storeId, { orderId, storeName, itemCount, grandTotal }) {
  const User = require('../models/User');
  const { RoleGroups } = require('../constants/roles');
  const staffUsers = await User.find({
    storeId,
    roles: { $in: RoleGroups.STORE_OPERATORS },
    fcmToken: { $ne: null },
  });

  await Promise.all(staffUsers.map((u) =>
    sendNotification(u.fcmToken, {
      title: `New Order — ${storeName ?? 'Store'}`,
      body: `${itemCount} item${itemCount !== 1 ? 's' : ''} · ₹${Math.round(grandTotal)}`,
      data: { type: 'new_order', orderId: orderId.toString() },
    })
  ));
}

module.exports = { sendNotification, sendOrderConfirmation, sendOrderStatusUpdate, sendNewOrderToStaff };
