/**
 * FCM push notifications for Cloudflare Workers.
 * Uses the FCM HTTP v1 API with a Google service account JWT — no firebase-admin needed.
 *
 * Required env vars (set via `wrangler secret put`):
 *   FCM_CLIENT_EMAIL   — service account email
 *   FCM_PRIVATE_KEY    — service account private key (PEM, \n escaped)
 *   FIREBASE_PROJECT_ID — e.g. "my-project-12345"
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let _accessToken = null;
let _tokenExpiry = 0;

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function makeServiceAccountJWT(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const toSign = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(toSign));
  return `${toSign}.${base64url(sig)}`;
}

async function getAccessToken(clientEmail, privateKeyPem) {
  const now = Date.now();
  if (_accessToken && now < _tokenExpiry) return _accessToken;

  const jwt = await makeServiceAccountJWT(clientEmail, privateKeyPem);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Failed to get FCM access token: ${JSON.stringify(data)}`);

  _accessToken = data.access_token;
  _tokenExpiry = now + (data.expires_in - 60) * 1000; // refresh 1 min before expiry
  return _accessToken;
}

// env must be passed in from the Worker's env context
let _env = null;
function setEnv(env) { _env = env; }

async function sendNotification(fcmToken, { title, body, data = {} }) {
  if (!fcmToken || !_env) return;

  try {
    const token = await getAccessToken(_env.FCM_CLIENT_EMAIL, _env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'));
    const projectId = _env.FIREBASE_PROJECT_ID;

    const message = {
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: {
          priority: 'HIGH',
          notification: { channel_id: 'dq_orders', sound: 'default' },
        },
      },
    };

    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[FCM] Send failed: ${err}`);
    } else {
      console.log(`[FCM] Push sent: "${title}"`);
    }
  } catch (error) {
    console.warn(`[FCM] sendNotification error: ${error.message}`);
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
  const User = require('../models/User');
  const staffUsers = await User.find({
    storeId,
    role: { $in: ['staff', 'admin'] },
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

module.exports = { setEnv, sendNotification, sendOrderConfirmation, sendOrderStatusUpdate, sendNewOrderToStaff };
