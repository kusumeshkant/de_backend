require('dotenv').config();
const mongoose = require('mongoose');
const Store = require('./models/Store');
const Product = require('./models/Product');

const stores = [
  {
    name: 'Reliance Smart',
    address: 'MG Road, Bengaluru, Karnataka',
    imageUrl: 'https://picsum.photos/id/1011/500/500',
    latitude: 12.9716,
    longitude: 77.5946,
  },
  {
    name: 'DMart',
    address: 'Koramangala, Bengaluru, Karnataka',
    imageUrl: 'https://picsum.photos/id/1015/500/500',
    latitude: 12.9352,
    longitude: 77.6245,
  },
  {
    name: 'Big Bazaar',
    address: 'Whitefield, Bengaluru, Karnataka',
    imageUrl: 'https://picsum.photos/id/1016/500/500',
    latitude: 12.9698,
    longitude: 77.7499,
  },
  {
    name: 'JioMart',
    address: 'Indiranagar, Bengaluru, Karnataka',
    imageUrl: 'https://picsum.photos/id/1020/500/500',
    latitude: 12.9784,
    longitude: 77.6408,
  },
  {
    name: "Spencer's Retail",
    address: 'HSR Layout, Bengaluru, Karnataka',
    imageUrl: 'https://picsum.photos/id/1024/500/500',
    latitude: 12.9116,
    longitude: 77.6473,
  },
  {
    name: 'More Supermarket',
    address: 'Jayanagar, Bengaluru, Karnataka',
    imageUrl: 'https://picsum.photos/id/1027/500/500',
    latitude: 12.9308,
    longitude: 77.5834,
  },
];

const products = [
  { barcode: '8901030878977', name: 'Amul Butter 500g', description: 'Fresh dairy butter', price: 250 },
  { barcode: '8901063152021', name: 'Britannia Good Day', description: 'Cashew cookies 200g', price: 35 },
  { barcode: '8906004690018', name: 'Lay\'s Classic Salted', description: 'Potato chips 26g', price: 20 },
  { barcode: '8901058001091', name: 'Maggi 2-Minute Noodles', description: 'Masala flavour 70g', price: 14 },
  { barcode: '8901030591005', name: 'Amul Gold Milk 1L', description: 'Full cream milk', price: 68 },
  { barcode: '8901030800078', name: 'Amul Taaza Milk 500ml', description: 'Toned milk', price: 30 },
  { barcode: '8904153002011', name: 'Paper Boat Aamras', description: 'Mango drink 200ml', price: 25 },
  { barcode: '8901719113093', name: 'Tata Salt 1kg', description: 'Iodized salt', price: 24 },
  { barcode: '8901030678452', name: 'Amul Cheese Slice', description: 'Processed cheese 750g', price: 380 },
  { barcode: '8906000670018', name: 'Parle-G Biscuits', description: 'Glucose biscuits 799g', price: 50 },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Clear existing data
    await Store.deleteMany({});
    await Product.deleteMany({});
    console.log('Cleared existing stores and products');

    // Insert stores
    const insertedStores = await Store.insertMany(stores);
    console.log(`Inserted ${insertedStores.length} stores`);

    // Attach products to first store
    const firstStoreId = insertedStores[0]._id;
    const productsWithStore = products.map((p) => ({ ...p, storeId: firstStoreId }));
    const insertedProducts = await Product.insertMany(productsWithStore);
    console.log(`Inserted ${insertedProducts.length} products`);

    console.log('\nSeed complete!');
    console.log('Stores:', insertedStores.map((s) => s.name).join(', '));
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
