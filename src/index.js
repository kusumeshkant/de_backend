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

const startServer = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

  const app = express();
  const port = Number(process.env.PORT) || 4000;

  // Health check — responds immediately so Azure startup probe passes
  // before MongoDB finishes connecting
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Rate limiting — 200 requests per 15 minutes per IP
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
  });

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    validationRules: [depthLimit(7)],
  });

  await server.start();

  app.use(
    '/graphql',
    limiter,
    cors(),
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }) => {
        const user = await verifyToken(req);
        return { user };
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
