require('dotenv').config();

const { ApolloServer } = require('@apollo/server');
const { startServerAndCreateNextHandler } = require('@as-integrations/next');
const mongoose = require('mongoose');
const typeDefs = require('../src/schema/typeDefs');
const resolvers = require('../src/resolvers');
const { verifyToken } = require('../src/middleware/auth');
const User = require('../src/models/User');

// ── Startup env validation ────────────────────────────────────────────────────
// Non-fatal: logs missing vars and degrades gracefully.
// Never calls process.exit() — serverless workers must survive module init.
const REQUIRED_VARS = ['FIREBASE_SERVICE_ACCOUNT', 'MONGO_URI'];
const _missingVars = REQUIRED_VARS.filter((v) => !process.env[v]);
if (_missingVars.length > 0) {
  console.error('[startup] Missing required environment variables:', _missingVars.join(', '));
  console.error('[startup] Service will boot but requests requiring these vars will fail.');
  console.error('[startup] Fix: add these variables in your deployment environment settings.');
} else {
  console.log('[startup] All required environment variables present.');
}

// ── MongoDB connection caching (required for serverless) ─────────────────────
// Connections are reused across warm invocations. A failed connection is NOT
// cached — the next request will retry. Connection errors surface as GraphQL
// errors rather than crashing the worker.
let cached = global._mongoConn;
if (!cached) cached = global._mongoConn = { conn: null, promise: null };

async function connectDB() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set. Add it to your environment variables.');
  }
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(process.env.MONGO_URI)
      .then((m) => {
        console.log('[db] MongoDB connected');
        return m;
      })
      .catch((err) => {
        // Clear the cached promise so the next request retries
        cached.promise = null;
        console.error('[db] MongoDB connection failed:', err.message);
        throw err;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ── Apollo Server ─────────────────────────────────────────────────────────────
const server = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: process.env.NODE_ENV !== 'production',
  formatError: (formattedError, error) => {
    // Log server-side errors with context; clients see only the formatted error
    if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR') {
      console.error('[graphql] Internal error:', error?.message ?? formattedError.message);
    }
    return formattedError;
  },
});

const apolloHandler = startServerAndCreateNextHandler(server, {
  context: async (req) => {
    await connectDB();
    const user = await verifyToken(req);
    const dbUser = user
      ? await User.findOne({ firebase_uid: user.uid }).lean() ?? null
      : null;
    return { user, dbUser };
  },
});

// ── CORS policy ───────────────────────────────────────────────────────────────
// Flutter mobile apps do NOT send an Origin header — CORS does not apply.
// Browser-originated requests (web builds) require the origin to be listed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// ── Request handler ───────────────────────────────────────────────────────────
async function handler(req, res) {
  // Health check — responds immediately, bypasses GraphQL, auth, and MongoDB.
  // Use this to confirm the worker booted successfully after a deploy.
  if (req.method === 'GET' && (req.url === '/api/graphql/health' || req.url === '/graphql/health')) {
    return res.status(200).json({
      status: 'ok',
      firebase: _missingVars.includes('FIREBASE_SERVICE_ACCOUNT') ? 'missing_env' : 'configured',
      mongo:    _missingVars.includes('MONGO_URI')                ? 'missing_env' : 'configured',
      ts:       new Date().toISOString(),
    });
  }

  // CORS headers
  const requestOrigin = req.headers.origin;
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  } else if (requestOrigin) {
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-correlation-id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  return apolloHandler(req, res);
}

module.exports = handler;
