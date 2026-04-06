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
const server = new ApolloServer({ typeDefs, resolvers });

const handler = startServerAndCreateNextHandler(server, {
  context: async (req) => {
    await connectDB();
    const user = await verifyToken(req);
    return { user };
  },
});

module.exports = handler;
