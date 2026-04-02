const Razorpay = require('razorpay');
const crypto = require('crypto');

// Lazy-initialized so CF Workers secrets (injected via env, not process.env)
// are available before the first call. setEnv() is called in worker.js.
let _keyId = null;
let _keySecret = null;
let _razorpay = null;

function setRazorpayEnv(env) {
  _keyId = env.RAZORPAY_KEY_ID;
  _keySecret = env.RAZORPAY_KEY_SECRET;
  _razorpay = null; // reset so it is re-created with new keys if called again
}

function getRazorpay() {
  // Fallback to process.env for local Node.js dev
  const keyId = _keyId || process.env.RAZORPAY_KEY_ID;
  const keySecret = _keySecret || process.env.RAZORPAY_KEY_SECRET;
  if (!_razorpay) {
    _razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return _razorpay;
}

async function createRazorpayOrder(amount) {
  const order = await getRazorpay().orders.create({
    amount: Math.round(amount * 100), // convert to paise
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  });
  return { id: order.id, amount: order.amount, currency: order.currency };
}

function verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  const keySecret = _keySecret || process.env.RAZORPAY_KEY_SECRET;
  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(body)
    .digest('hex');
  return expectedSignature === razorpaySignature;
}

module.exports = { setRazorpayEnv, createRazorpayOrder, verifyPayment };
