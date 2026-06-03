const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  storeCode: { type: String, unique: true, sparse: true },
  address: { type: String },
  imageUrl: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  // GeoJSON location field — enables 2dsphere index for proper geo queries at scale.
  // Populated from latitude/longitude on store create/update.
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined }, // [longitude, latitude]
  },
  // Physical context for mall/multi-store disambiguation
  floor: { type: String },
  buildingId: { type: String },
  isActive: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
});

// Geospatial index — required for nearbyStores at scale
storeSchema.index({ location: '2dsphere' }, { sparse: true });

module.exports = mongoose.model('Store', storeSchema);
