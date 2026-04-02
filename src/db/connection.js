/**
 * MongoDB connection with global caching for serverless/edge environments.
 * CF Workers reuse the same V8 isolate between requests — the `_conn` global
 * persists across invocations so we only create one Mongoose connection per
 * isolate instance (equivalent to Node.js module-level singleton).
 */

const mongoose = require('mongoose');

let _conn = null;
let _connecting = null;

async function connectDB(mongoUri) {
  if (_conn && _conn.readyState === 1) {
    return _conn;
  }

  // If a connection is in progress, wait for it
  if (_connecting) {
    await _connecting;
    return _conn;
  }

  _connecting = mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    // CF Workers: disable mongoose buffering since we manage the connection manually
    bufferCommands: false,
  });

  await _connecting;
  _conn = mongoose.connection;
  _connecting = null;

  console.log('[MongoDB] Connected');
  return _conn;
}

module.exports = { connectDB };
