require('dotenv').config();

// Application Insights — must be initialised before anything else
const appInsights = require('applicationinsights');
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  appInsights.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING).start();
}

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const depthLimit = require('graphql-depth-limit');
const mongoose = require('mongoose');
const typeDefs = require('./schema/typeDefs');
const resolvers = require('./resolvers');
const { verifyToken } = require('./middleware/auth');
const logger = require('./utils/logger');
const validateSchema = require('./utils/validate_schema');

if (process.env.NODE_ENV !== 'production') validateSchema();

// ── CORS allowlist ────────────────────────────────────────────────────────────
// Only origins listed here can send cross-origin requests to the API.
// Mobile apps (Flutter) are not subject to CORS — this protects any web client
// (dqstore.in, future admin web panel) from third-party sites making requests
// on behalf of a logged-in user.
const ALLOWED_ORIGINS = [
  // Production
  'https://dqstore.in',
  'https://app.dqstore.in',
  'https://staff.dqstore.in',
  'https://dq.dqstore.in',
  // UAT
  'https://uat-app.dqstore.in',
  'https://uat-staff.dqstore.in',
  'https://uat-admin.dqstore.in',
  // DEV
  'https://dev-app.dqstore.in',
  'https://dev-staff.dqstore.in',
  'https://dev-admin.dqstore.in',
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:5000', 'http://localhost:8080'] : []),
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no Origin header (mobile apps, Postman, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${origin}' is not allowed`));
    }
  },
  credentials: false,
};

const startServer = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

  const app = express();
  const port = Number(process.env.PORT) || 4000;

  // Health check — responds immediately so Azure startup probe passes
  // before MongoDB finishes connecting
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Version check — helps verify environment & deployment
  app.get('/version', (req, res) => {
    res.json({
      env: process.env.NODE_ENV || "unknown",
      version: "UAT-v2-products-pagination",
      timestamp: new Date().toISOString()
    });
  });

  // Rate limiting — 200 requests per 15 minutes per IP
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
  });

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    validationRules: [depthLimit(7)],
    // Apollo Server v4 disables introspection automatically in production
    // (when NODE_ENV=production). Explicit override only needed in dev.
    introspection: process.env.NODE_ENV !== 'production',
  });

  await server.start();

  // User model — loaded once here so the context function doesn't require() it
  // on every request (require() is cached, but explicit import is cleaner).
  const User = require('./models/User');
  // app.use(express.json());
  app.use(
    '/graphql',
    limiter,
    cors(corsOptions),
    express.json(),
    expressMiddleware(server, {
      /**
       * Request context — built once per GraphQL request, shared by all resolvers.
       *
       * Shape:
       *   context.user   — Firebase identity  { uid, email, phone } | null
       *   context.dbUser — MongoDB User doc    { _id, roles, ... }  | null
       *
       * Keeping backward compatibility: existing resolvers that read context.user
       * continue to work unchanged. The new context.dbUser eliminates the
       * per-resolver getOrCreateUser() call (N+1 MongoDB queries → 1 per request).
       *
       * User auto-creation (getOrCreateUser) intentionally stays in the
       * validateAppAccess resolver — it is the explicit first-login gate and
       * should only create documents when the user actively authenticates,
       * not silently on every request.
       */
      context: async ({ req }) => {
        const user = await verifyToken(req);

        if (!user) {
          return { user: null, dbUser: null };
        }

        // Single MongoDB lookup per request — result shared across all resolvers.
        // Using .lean() returns a plain JS object (faster, no Mongoose overhead)
        // which is sufficient for read-only access in resolvers.
        const dbUser = await User.findOne({ firebase_uid: user.uid }).lean() ?? null;

        return { user, dbUser };
      },
    })
  );

  // Start listening BEFORE connecting to MongoDB so the startup probe passes
  app.listen(port, () => {
    logger.info(`Server listening on port ${port}`);
  });

  // Connect to MongoDB in the background
  mongoose.connect(process.env.MONGO_URI)
    .then(() => logger.info('Connected to MongoDB'))
    .catch((err) => {
      logger.error(`MongoDB connection failed: ${err.message}`);
      process.exit(1);
    });
};

startServer().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
