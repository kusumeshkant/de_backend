require('dotenv').config();
const mongoose = require('mongoose');
const Store = require('./models/Store');
const Product = require('./models/Product');

// Fashion & lifestyle retail stores in Bengaluru
const stores = [
  {
    name: 'Zudio',
    storeCode: 'ZUD001',
    address: 'Phoenix Marketcity, Whitefield, Bengaluru',
    imageUrl: 'https://picsum.photos/id/1011/500/500',
    latitude: 12.9698,
    longitude: 77.7499,
  },
  {
    name: 'Zara',
    storeCode: 'ZAR001',
    address: 'UB City Mall, Vittal Mallya Road, Bengaluru',
    imageUrl: 'https://picsum.photos/id/1015/500/500',
    latitude: 12.9726,
    longitude: 77.5936,
  },
  {
    name: 'Puma',
    storeCode: 'PUM001',
    address: '100 Feet Road, Indiranagar, Bengaluru',
    imageUrl: 'https://picsum.photos/id/1016/500/500',
    latitude: 12.9784,
    longitude: 77.6408,
  },
  {
    name: 'H&M',
    storeCode: 'HNM001',
    address: 'Orion Mall, Rajajinagar, Bengaluru',
    imageUrl: 'https://picsum.photos/id/1020/500/500',
    latitude: 12.9929,
    longitude: 77.5548,
  },
  {
    name: 'Westside',
    storeCode: 'WST001',
    address: 'Forum Mall, Koramangala, Bengaluru',
    imageUrl: 'https://picsum.photos/id/1024/500/500',
    latitude: 12.9352,
    longitude: 77.6245,
  },
  {
    name: 'Nike',
    storeCode: 'NKE001',
    address: 'MG Road, Bengaluru',
    imageUrl: 'https://picsum.photos/id/1027/500/500',
    latitude: 12.9716,
    longitude: 77.6134,
  },
];

// Per-store inventory
const inventoryByStore = {
  Zudio: [
    { barcode: 'ZUD0000000001', name: 'Zudio Slim Fit Jeans', description: 'Dark blue slim fit jeans, men', price: 799, stock: 50 },
    { barcode: 'ZUD0000000002', name: 'Zudio Graphic Tee', description: 'Round neck printed t-shirt, men', price: 299, stock: 80 },
    { barcode: 'ZUD0000000003', name: 'Zudio Floral Kurti', description: 'Cotton floral print kurti, women', price: 499, stock: 60 },
    { barcode: 'ZUD0000000004', name: 'Zudio Jogger Pants', description: 'Comfortable jogger pants, unisex', price: 599, stock: 45 },
    { barcode: 'ZUD0000000005', name: 'Zudio Striped Shirt', description: 'Casual striped shirt, men', price: 399, stock: 55 },
    { barcode: 'ZUD0000000006', name: 'Zudio Summer Dress', description: 'Lightweight summer dress, women', price: 649, stock: 40 },
    { barcode: 'ZUD0000000007', name: 'Zudio Cargo Shorts', description: 'Multi-pocket cargo shorts, men', price: 449, stock: 35 },
    { barcode: 'ZUD0000000008', name: 'Zudio Ethnic Kurta Set', description: 'Cotton kurta and pyjama set, men', price: 899, stock: 30 },
  ],

  Zara: [
    { barcode: 'ZRA0000000001', name: 'Zara Tailored Blazer', description: 'Classic fit blazer, women', price: 5990, stock: 20 },
    { barcode: 'ZRA0000000002', name: 'Zara Satin Midi Dress', description: 'Elegant satin midi dress, women', price: 4490, stock: 15 },
    { barcode: 'ZRA0000000003', name: 'Zara Slim Chinos', description: 'Smart casual slim chinos, men', price: 3490, stock: 25 },
    { barcode: 'ZRA0000000004', name: 'Zara Linen Shirt', description: 'Breathable linen shirt, men', price: 2990, stock: 30 },
    { barcode: 'ZRA0000000005', name: 'Zara Knit Cardigan', description: 'Soft knit cardigan, women', price: 3990, stock: 18 },
    { barcode: 'ZRA0000000006', name: 'Zara Wide Leg Trousers', description: 'High waist wide leg trousers, women', price: 3290, stock: 22 },
    { barcode: 'ZRA0000000007', name: 'Zara Denim Jacket', description: 'Classic denim jacket, unisex', price: 4990, stock: 12 },
    { barcode: 'ZRA0000000008', name: 'Zara Flowy Blouse', description: 'Lightweight flowy blouse, women', price: 2490, stock: 28 },
  ],

  Puma: [
    { barcode: 'PUM0000000001', name: 'Puma Softride Pro Shoes', description: 'Running shoes, unisex', price: 4999, stock: 30 },
    { barcode: 'PUM0000000002', name: 'Puma Dry Cell Tee', description: 'Moisture wicking sports tee, men', price: 1299, stock: 50 },
    { barcode: 'PUM0000000003', name: 'Puma Training Shorts', description: 'Quick dry training shorts, men', price: 1499, stock: 45 },
    { barcode: 'PUM0000000004', name: 'Puma Zip Up Hoodie', description: 'Fleece zip up hoodie, unisex', price: 2999, stock: 25 },
    { barcode: 'PUM0000000005', name: 'Puma Track Pants', description: 'Classic track pants with stripes, unisex', price: 1999, stock: 40 },
    { barcode: 'PUM0000000006', name: 'Puma Sports Bra', description: 'High support sports bra, women', price: 1799, stock: 35 },
    { barcode: 'PUM0000000007', name: 'Puma Suede Classic Shoes', description: 'Lifestyle suede sneakers, unisex', price: 5999, stock: 20 },
    { barcode: 'PUM0000000008', name: 'Puma Backpack 25L', description: 'Sports backpack with laptop sleeve', price: 2499, stock: 15 },
  ],

  'H&M': [
    { barcode: 'HNM0000000001', name: 'H&M Oversized Hoodie', description: 'Cotton blend oversized hoodie, unisex', price: 1999, stock: 40 },
    { barcode: 'HNM0000000002', name: 'H&M Slim Fit Trousers', description: 'Smart slim fit trousers, men', price: 1799, stock: 35 },
    { barcode: 'HNM0000000003', name: 'H&M Ribbed Tank Top', description: 'Ribbed cotton tank top, women', price: 799, stock: 60 },
    { barcode: 'HNM0000000004', name: 'H&M Mom Jeans', description: 'High waist mom jeans, women', price: 2499, stock: 30 },
    { barcode: 'HNM0000000005', name: 'H&M Linen Blend Shirt', description: 'Relaxed fit linen blend shirt, men', price: 1499, stock: 45 },
    { barcode: 'HNM0000000006', name: 'H&M Floral Wrap Dress', description: 'V-neck floral wrap dress, women', price: 1999, stock: 25 },
    { barcode: 'HNM0000000007', name: 'H&M Puffer Jacket', description: 'Lightweight puffer jacket, unisex', price: 3499, stock: 20 },
    { barcode: 'HNM0000000008', name: 'H&M Basic Crew Tee', description: 'Pack of 3 basic crew neck tees', price: 1299, stock: 55 },
  ],

  Westside: [
    { barcode: 'WST0000000001', name: 'Westside Anarkali Suit', description: 'Embroidered anarkali suit set, women', price: 2499, stock: 20 },
    { barcode: 'WST0000000002', name: 'Westside Nehru Jacket', description: 'Cotton Nehru collar jacket, men', price: 1799, stock: 25 },
    { barcode: 'WST0000000003', name: 'Westside Palazzo Set', description: 'Printed palazzo and top set, women', price: 1299, stock: 35 },
    { barcode: 'WST0000000004', name: 'Westside Casual Blazer', description: 'Unstructured casual blazer, men', price: 2999, stock: 18 },
    { barcode: 'WST0000000005', name: 'Westside Maxi Skirt', description: 'Flowy printed maxi skirt, women', price: 999, stock: 40 },
    { barcode: 'WST0000000006', name: 'Westside Kurta Pyjama', description: 'Festive kurta pyjama set, men', price: 1999, stock: 30 },
    { barcode: 'WST0000000007', name: 'Westside Lehenga Set', description: 'Party wear lehenga choli set, women', price: 3499, stock: 12 },
    { barcode: 'WST0000000008', name: 'Westside Linen Trousers', description: 'Straight fit linen trousers, men', price: 1499, stock: 28 },
  ],

  Nike: [
    { barcode: 'NKE0000000001', name: 'Nike Air Max 270', description: 'Lifestyle running shoes, unisex', price: 10995, stock: 15 },
    { barcode: 'NKE0000000002', name: 'Nike Dri-FIT Tee', description: 'Performance training tee, men', price: 1995, stock: 40 },
    { barcode: 'NKE0000000003', name: 'Nike Pro Tights', description: 'Compression training tights, women', price: 2995, stock: 30 },
    { barcode: 'NKE0000000004', name: 'Nike Tech Fleece Hoodie', description: 'Lightweight tech fleece hoodie, men', price: 7995, stock: 18 },
    { barcode: 'NKE0000000005', name: 'Nike Windrunner Jacket', description: 'Packable windrunner jacket, unisex', price: 5995, stock: 20 },
    { barcode: 'NKE0000000006', name: 'Nike Court Vision Shoes', description: 'Casual lifestyle sneakers, unisex', price: 6495, stock: 22 },
    { barcode: 'NKE0000000007', name: 'Nike Swoosh Sports Bra', description: 'Medium support sports bra, women', price: 2495, stock: 35 },
    { barcode: 'NKE0000000008', name: 'Nike Heritage Backpack', description: 'Iconic nike heritage backpack', price: 3495, stock: 12 },
  ],
};

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

    // Insert products for each store
    let totalProducts = 0;
    for (const store of insertedStores) {
      const storeProducts = inventoryByStore[store.name];
      if (!storeProducts) continue;
      const productsWithStore = storeProducts.map((p) => ({ ...p, storeId: store._id }));
      await Product.insertMany(productsWithStore);
      totalProducts += storeProducts.length;
      console.log(`  ${store.name}: ${storeProducts.length} products added`);
    }

    console.log(`\nSeed complete!`);
    console.log(`Stores: ${insertedStores.map((s) => s.name).join(', ')}`);
    console.log(`Total products: ${totalProducts}`);
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
