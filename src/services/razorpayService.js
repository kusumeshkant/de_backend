const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

async function createRazorpayOrder(amount) {
  const order = await razorpay.orders.create({
    amount: Math.round(amount * 100), // convert to paise
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  });
  return { id: order.id, amount: order.amount, currency: order.currency };
}

function verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expectedSignature === razorpaySignature;
}

module.exports = { createRazorpayOrder, verifyPayment };
