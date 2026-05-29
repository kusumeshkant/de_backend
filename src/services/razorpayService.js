const Razorpay = require('razorpay');
const crypto = require('crypto');
const PendingPayment = require('../models/PendingPayment');
const Product = require('../models/Product');
const { validateDiscountCode } = require('./discountService');
const { ErrorHandler } = require('../utils/errorHandler');

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

// ── Subscription payments — amount is server-computed by plan lookup ──────────
// Renamed from createRazorpayOrder; called only from createSubscriptionOrder
// where the amount is already server-determined (plan price from DB).
async function createRazorpayOrderForAmount(amount) {
  const order = await getRazorpay().orders.create({
    amount: Math.round(amount * 100), // convert to paise
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  });
  return { id: order.id, amount: order.amount, currency: order.currency };
}

// ── Cart payments — amount is server-computed from live catalogue prices ──────
// Replaces the old createRazorpayOrder(amount) for the customer cart flow.
// The client sends items; the server looks up live prices and computes the total.
// A PendingPayment record anchors the server-computed total to the Razorpay
// order ID so createOrder can verify it without trusting the client's grandTotal.
async function createRazorpayOrderFromCart({ userId, storeId, items, discountCode = null }) {
  // Recompute total from live catalogue prices — client never touches this
  let serverTotal = 0;
  for (const item of items) {
    const product = await Product.findOne({ barcode: item.barcode, storeId });
    if (!product) {
      throw new ErrorHandler(`Product not found: ${item.barcode}`, 400);
    }
    serverTotal += product.price * (item.quantity ?? 1);
  }

  // Apply server-validated discount if provided.
  // validateDiscountCode takes { code, storeId, subtotal } and returns { finalAmount, ... }
  if (discountCode) {
    const discount = await validateDiscountCode({ code: discountCode, storeId, subtotal: serverTotal });
    serverTotal = discount.finalAmount;
  }

  // Add 18% GST (matches Flutter: tax = subtotal * 0.18, grandTotal = subtotal + tax)
  const totalWithTax = Math.round(serverTotal * 1.18 * 100) / 100;

  const rzpOrder = await getRazorpay().orders.create({
    amount: Math.round(totalWithTax * 100),
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  });

  // Anchor server-computed total to this Razorpay order ID
  await PendingPayment.create({
    razorpayOrderId: rzpOrder.id,
    userId,
    storeId,
    items,
    serverTotal: totalWithTax,
    discountCode,
  });

  return { id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency };
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

module.exports = { setRazorpayEnv, createRazorpayOrderForAmount, createRazorpayOrderFromCart, verifyPayment };
