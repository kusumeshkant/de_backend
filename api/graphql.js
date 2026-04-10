require('dotenv').config();

const { ApolloServer } = require('@apollo/server');
const { startServerAndCreateNextHandler } = require('@as-integrations/next');
const mongoose = require('mongoose');
const typeDefs = require('../src/schema/typeDefs');
const resolvers = require('../src/resolvers');
const { verifyToken } = require('../src/middleware/auth');

// ── MongoDB connection caching (required for serverless) ─────────────────────
let cached = global._mongoConn;
if (!cached) cached = global._mongoConn = { conn: null, promise: null };

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI).then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ── Apollo Server (created once, reused across invocations) ──────────────────
// Introspection is only enabled outside production so developers can explore
// the schema locally via Apollo Sandbox, but the schema is NOT discoverable
// by external parties on the live API.
const server = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: process.env.NODE_ENV !== 'production',
});

const apolloHandler = startServerAndCreateNextHandler(server, {
  context: async (req) => {
    await connectDB();
    const user = await verifyToken(req);
    return { user };
  },
});

// ── CORS policy ───────────────────────────────────────────────────────────────
// This is a mobile-only API (dq_app, dq_staff, dq_admin are Android/iOS apps).
// Mobile apps do not send an Origin header and are NOT subject to CORS.
// Setting Access-Control-Allow-Origin to 'null' blocks all browser-originated
// cross-origin requests, which prevents a browser-based attacker from using a
// stolen Firebase token to exfiltrate data from a web page.
// If a trusted web admin panel is added in the future, add its exact origin to
// ALLOWED_ORIGINS instead of reverting to '*'.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

async function handler(req, res) {
  const requestOrigin = req.headers.origin;

  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    // Known trusted browser origin (e.g. a web admin panel).
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  } else if (requestOrigin) {
    // Unknown browser origin — deny cross-origin access.
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  // If there is no Origin header (mobile app, server-to-server) — no CORS
  // headers are needed or set.

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  return apolloHandler(req, res);
}

module.exports = handler;
