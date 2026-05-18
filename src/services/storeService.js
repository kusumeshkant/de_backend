const mongoose = require('mongoose');
const Store = require('../models/Store');
const { startTrial } = require('./subscription_service');

async function getStores() {
  return await Store.find({ isActive: true }).sort({ name: 1 });
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
  const stores = await Store.find({ isActive: true });
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

/**
 * Derives a 3-letter uppercase prefix from the store name.
 * Strips non-alpha characters, takes the first 3 letters, pads with 'X'.
 * Examples: "H&M" → "HMX", "Nike" → "NIK", "Zudio" → "ZUD"
 */
function _codePrefix(name) {
  return name
    .replace(/[^a-zA-Z]/g, '')
    .substring(0, 3)
    .toUpperCase()
    .padEnd(3, 'X');
}

async function _generateStoreCode(name) {
  const prefix = _codePrefix(name);
  const existing = await Store.find({ storeCode: new RegExp(`^${prefix}\\d`) }).select('storeCode');
  const maxNum = existing.reduce((max, s) => {
    const num = parseInt((s.storeCode ?? '').substring(3), 10);
    return !isNaN(num) && num > max ? num : max;
  }, 0);
  return `${prefix}${String(maxNum + 1).padStart(3, '0')}`;
}

async function createStore({ name, address, lat, lon, storeCode }, triggeredByUid = 'system') {
  const code  = storeCode?.trim().toUpperCase() || await _generateStoreCode(name);
  const store = new Store({ name, storeCode: code, address, latitude: lat, longitude: lon });
  await store.save();

  // Every new store starts on a trial plan automatically.
  // Fire-and-forget — don't fail store creation if subscription setup fails.
  // Kill switch: set SUBSCRIPTION_ENABLED=false in env to disable entirely.
  if (process.env.SUBSCRIPTION_ENABLED !== 'false') {
    try {
      await startTrial(store._id, triggeredByUid);
    } catch (err) {
      console.error(`[storeService] startTrial failed for store ${store._id}: ${err.message}`);
    }
  }

  return store;
}

async function updateStore(id, { name, address, lat, lon, storeCode, isActive }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (address !== undefined) update.address = address;
  if (lat !== undefined) update.latitude = lat;
  if (lon !== undefined) update.longitude = lon;
  if (storeCode !== undefined) update.storeCode = storeCode.trim().toUpperCase();
  if (isActive !== undefined) update.isActive = isActive;
  return await Store.findByIdAndUpdate(id, update, { new: true });
}

async function deleteStore(id) {
  const result = await Store.findByIdAndDelete(id);
  return !!result;
}

// ── Cursor helpers ─────────────────────────────────────────────────────────────

function _encodeCursor(id) {
  return Buffer.from(JSON.stringify({ id: id.toString() })).toString('base64');
}

function _decodeCursor(cursor) {
  try { return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); } catch { return null; }
}

// ── Paginated stores ───────────────────────────────────────────────────────────

async function getStoresPaginated({ first = 30, after = null, search = null, storeId = null } = {}) {
  const limit = Math.min(Math.max(1, first || 30), 100);

  const baseFilter = { isActive: true };
  if (storeId) baseFilter._id = storeId;
  if (search)  baseFilter.$or = [
    { name:      { $regex: search, $options: 'i' } },
    { storeCode: { $regex: search, $options: 'i' } },
    { address:   { $regex: search, $options: 'i' } },
  ];

  const decoded = after ? _decodeCursor(after) : null;
  const cursorFilter = decoded
    ? { _id: { $gt: mongoose.Types.ObjectId.createFromHexString(decoded.id) } }
    : {};

  const [rows, totalCount] = await Promise.all([
    Store.find({ ...baseFilter, ...cursorFilter }).sort({ name: 1, _id: 1 }).limit(limit + 1),
    Store.countDocuments(baseFilter),
  ]);

  const hasNext = rows.length > limit;
  if (hasNext) rows.pop();
  const lastRow    = rows[rows.length - 1];
  const nextCursor = hasNext && lastRow ? _encodeCursor(lastRow._id) : null;

  return { items: rows, meta: { hasNext, nextCursor, totalCount } };
}

module.exports = { getStores, getStoreById, getNearbyStores, createStore, updateStore, deleteStore, getStoresPaginated };
