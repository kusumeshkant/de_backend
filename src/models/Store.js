const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: { type: String },
  imageUrl: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Store', storeSchema);
