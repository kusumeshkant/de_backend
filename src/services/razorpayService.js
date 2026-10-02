const Razorpay = require('razorpay');
const crypto = require('crypto');
const { GraphQLError } = require('graphql');
const PendingPayment = require('../models/PendingPayment');
const Product = require('../models/Product');
const { validateDiscountCode } = require('./discountService');

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

// ── Cart payments — everything is server-computed from the live catalogue ─────
// The client sends only barcodes and quantities. The server validates them,
// builds the line items from the catalogue (name and price included), computes
// subtotal → discount → GST → grand total, creates the Razorpay order for that
// amount, and stores ALL of it in a PendingPayment. createOrder later builds the
// Order from that record alone (A3) — nothing the client sends is trusted.

const MAX_CART_LINES = 50;
const MAX_LINE_QUANTITY = 99;
const GST_RATE = 0.18;

const toPaise = (rupees) => Math.round(rupees * 100);
const toRupees = (paise) => paise / 100;

function badInput(message, code = 'BAD_USER_INPUT') {
  return new GraphQLError(message, { extensions: { code } });
}

// Validates the cart shape and merges duplicate barcodes. Quantities must be
// whole numbers 1..MAX_LINE_QUANTITY — a zero, negative or fractional quantity
// would otherwise lower the server-computed total.
function normaliseCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw badInput('Your cart is empty');
  const lines = new Map();
  for (const item of items) {
    const barcode = typeof item?.barcode === 'string' ? item.barcode.trim() : '';
    const quantity = item?.quantity ?? 1;
    if (!barcode) throw badInput('Every cart item needs a barcode');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
      throw badInput(`Invalid quantity for ${barcode}: must be a whole number from 1 to ${MAX_LINE_QUANTITY}`);
    }
    lines.set(barcode, (lines.get(barcode) ?? 0) + quantity);
  }
  if (lines.size > MAX_CART_LINES) throw badInput(`A cart can hold at most ${MAX_CART_LINES} different products`);
  for (const [barcode, quantity] of lines) {
    if (quantity > MAX_LINE_QUANTITY) {
      throw badInput(`Invalid quantity for ${barcode}: must be a whole number from 1 to ${MAX_LINE_QUANTITY}`);
    }
  }
  return lines;
}

async function createRazorpayOrderFromCart({ userId, storeId, items, discountCode = null }) {
  const lines = normaliseCart(items);

  // Build line items from the catalogue. Unavailable (soft-deleted) products and
  // insufficient stock are rejected here, before the customer is asked to pay.
  const serverItems = [];
  let subtotalPaise = 0;
  for (const [barcode, quantity] of lines) {
    const product = await Product.findOne({ barcode, storeId, isAvailable: { $ne: false } });
    if (!product) {
      throw badInput(`Product not found or no longer available: ${barcode}`, 'PRODUCT_UNAVAILABLE');
    }
    if ((product.stock ?? 0) < quantity) {
      throw badInput(`Only ${product.stock ?? 0} left of ${product.name}`, 'OUT_OF_STOCK');
    }
    const pricePaise = toPaise(product.price);
    subtotalPaise += pricePaise * quantity;
    serverItems.push({
      barcode,
      name: product.name,
      mrp: product.mrp ?? product.price,
      price: toRupees(pricePaise),
      quantity,
      sku: product.sku ?? undefined,
      description: product.description ?? undefined,
    });
  }

  // Server-validated discount on the subtotal.
  let discountedPaise = subtotalPaise;
  const code = discountCode ? discountCode.trim().toUpperCase() : null;
  if (code) {
    const discount = await validateDiscountCode({ code, storeId, subtotal: toRupees(subtotalPaise) });
    discountedPaise = Math.min(subtotalPaise, Math.max(0, toPaise(discount.finalAmount)));
  }

  // 18% GST on the discounted subtotal, all in whole paise so that
  // total + tax === grandTotal exactly (S-7).
  const taxPaise = Math.round(discountedPaise * GST_RATE);
  const grandPaise = discountedPaise + taxPaise;
  if (grandPaise < 100) throw badInput('Order total must be at least ₹1');

  const rzpOrder = await getRazorpay().orders.create({
    amount: grandPaise,
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
    notes: { storeId: String(storeId), userId: String(userId) },
  });

  await PendingPayment.create({
    razorpayOrderId: rzpOrder.id,
    userId,
    storeId,
    items: serverItems,
    subtotal: toRupees(subtotalPaise),
    discountAmount: toRupees(subtotalPaise - discountedPaise),
    total: toRupees(discountedPaise),
    tax: toRupees(taxPaise),
    serverTotal: toRupees(grandPaise),
    amountPaise: grandPaise,
    discountCode: code,
  });

  return {
    id: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    // The client must open checkout with the same key the order was created
    // with — returning it here means client and server can never disagree.
    keyId: _keyId || process.env.RAZORPAY_KEY_ID,
  };
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
