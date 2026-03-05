const Store = require('../models/Store');

async function getStores() {
  return await Store.find().sort({ name: 1 });
}

async function getStoreById(id) {
  return await Store.findById(id);
}

module.exports = { getStores, getStoreById };
