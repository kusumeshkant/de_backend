const Store = require('../models/Store');

async function getStores() {
  return await Store.find().sort({ name: 1 });
}

async function getStoreById(id) {
  return await Store.findById(id);
}

/**
 * Returns all onboarded stores sorted by distance from the given coordinates.
 * Stores without lat/lon are appended at the end.
 * @param {number} lat  User latitude
 * @param {number} lon  User longitude
 * @param {number} radiusKm  Max radius — pass Infinity to return all stores sorted by distance
 */
async function getNearbyStores(lat, lon, radiusKm = Infinity) {
  const stores = await Store.find();
  return stores
    .map((store) => {
      const obj = store.toObject();
      if (store.latitude != null && store.longitude != null) {
        obj.distanceKm = _haversineKm(lat, lon, store.latitude, store.longitude);
      } else {
        obj.distanceKm = null;
      }
      return obj;
    })
    .filter((s) => s.distanceKm === null || s.distanceKm <= radiusKm)
    .sort((a, b) => {
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

function _haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { getStores, getStoreById, getNearbyStores };
