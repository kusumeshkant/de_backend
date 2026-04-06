/**
 * FCM push notifications using firebase-admin SDK.
 * firebase-admin is already initialized in middleware/auth.js
 */
const User = require('../models/User');

function getMessaging() {
  // Require firebase-admin lazily so it's already initialized by auth.js
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    console.warn('[FCM] firebase-admin not initialized yet');
    return null;
  }
  return admin.messaging();
}

async function sendNotification(fcmToken, { title, body, data = {} }) {
  if (!fcmToken) return;
  const messaging = getMessaging();
  if (!messaging) return;
  try {
    await messaging.send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: { channelId: 'dq_orders', sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    });
    console.log(`[FCM] Push sent: "${title}"`);
  } catch (err) {
    console.warn(`[FCM] sendNotification error: ${err.message}`);
  }
}

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
    title: 'Order Being Prepared',
    body: (store) => `Your order ${store} is now being prepared.`,
  },
  ready: {
    title: 'Order Ready for Pickup!',
    body: (store) => `Your order ${store} is ready. Please proceed to collect it.`,
  },
  completed: {
    title: 'Order Completed',
    body: (store) => `Your order ${store} has been completed. Thank you!`,
  },
  cancelled: {
    title: 'Order Cancelled',
    body: (store) => `Your order ${store} has been cancelled.`,
  },
};

async function sendOrderStatusUpdate(fcmToken, { status, storeName }) {
  const template = STATUS_MESSAGES[status];
  if (!template) return;
  const store = storeName ? `at ${storeName}` : '';
  await sendNotification(fcmToken, {
    title: template.title,
    body: template.body(store),
    data: { type: 'order_status_update', status },
  });
}

async function sendNewOrderToStaff(storeId, { orderId, storeName, itemCount, grandTotal }) {
  try {
    const staffUsers = await User.find({
      storeId,
      roles: { $in: ['staff', 'admin'] },
      fcmToken: { $ne: null },
    });

    await Promise.all(staffUsers.map((u) =>
      sendNotification(u.fcmToken, {
        title: `New Order — ${storeName ?? 'Store'}`,
        body: `${itemCount} item${itemCount !== 1 ? 's' : ''} · ₹${Math.round(grandTotal)}`,
        data: { type: 'new_order', orderId: orderId.toString() },
      })
    ));
  } catch (err) {
    console.warn(`[FCM] sendNewOrderToStaff error: ${err.message}`);
  }
}

module.exports = { sendNotification, sendOrderConfirmation, sendOrderStatusUpdate, sendNewOrderToStaff };
