require('dotenv').config();
const mongoose = require('mongoose');
const Store = require('./models/Store');
const Product = require('./models/Product');
const Order = require('./models/Order');
const User = require('./models/User');

const TAX_RATE = 0.05;

function calcTotals(items) {
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const tax = parseFloat((total * TAX_RATE).toFixed(2));
  const grandTotal = parseFloat((total + tax).toFixed(2));
  return { total, tax, grandTotal };
}

async function seedOrders() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Find or create a test customer user
    let customer = await User.findOne({ role: 'customer' });
    if (!customer) {
      customer = await User.create({
        firebase_uid: 'test_customer_seed_uid',
        name: 'Test Customer',
        email: 'testcustomer@dq.com',
        role: 'customer',
      });
      console.log('Created test customer user');
    } else {
      console.log(`Using existing customer: ${customer.email || customer.name}`);
    }

    // Load all stores with their products
    const stores = await Store.find({});
    if (stores.length === 0) {
      console.error('No stores found. Run seed.js first.');
      process.exit(1);
    }

    // Clear existing orders
    await Order.deleteMany({});
    console.log('Cleared existing orders');

    const statuses = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
    let totalOrders = 0;

    for (const store of stores) {
      const products = await Product.find({ storeId: store._id }).limit(4);
      if (products.length === 0) continue;

      const storeOrders = [];

      // Create one order per status (5 orders per store)
      for (let i = 0; i < statuses.length; i++) {
        const status = statuses[i];
        // Pick 1-3 products for this order
        const orderProducts = products.slice(0, (i % 3) + 1);
        const items = orderProducts.map((p) => ({
          barcode: p.barcode,
          name: p.name,
          price: p.price,
          quantity: (i % 2) + 1,
        }));
        const { total, tax, grandTotal } = calcTotals(items);

        const staffActions = [];
        if (['preparing', 'ready', 'completed', 'cancelled'].includes(status)) {
          staffActions.push({
            staffId: 'seed_staff',
            staffName: 'Seed Staff',
            action: 'started_preparing',
            timestamp: new Date(Date.now() - 30 * 60 * 1000),
            note: null,
          });
        }
        if (['ready', 'completed'].includes(status)) {
          staffActions.push({
            staffId: 'seed_staff',
            staffName: 'Seed Staff',
            action: 'marked_ready',
            timestamp: new Date(Date.now() - 15 * 60 * 1000),
            note: null,
          });
        }
        if (status === 'completed') {
          staffActions.push({
            staffId: 'seed_staff',
            staffName: 'Seed Staff',
            action: 'completed',
            timestamp: new Date(Date.now() - 5 * 60 * 1000),
            note: null,
          });
        }

        storeOrders.push({
          user: customer._id,
          storeId: store._id,
          items,
          total,
          tax,
          grandTotal,
          status,
          staffActions,
          createdAt: new Date(Date.now() - (statuses.length - i) * 60 * 60 * 1000),
        });
      }

      await Order.insertMany(storeOrders);
      totalOrders += storeOrders.length;
      console.log(`  ${store.name} (${store.storeCode}): ${storeOrders.length} orders added`);
    }

    console.log(`\nOrder seed complete! Total orders: ${totalOrders}`);
    console.log(`Statuses seeded: ${statuses.join(', ')}`);
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seedOrders();
