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
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

    await mongoose.connect(process.env.MONGO_URI);
    logger.info('Connected to MongoDB');

    const app = express();

    // Health check for Azure Container Apps liveness/readiness probes
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

    const port = Number(process.env.PORT) || 4000;
    app.listen(port, () => {
      logger.info(`GraphQL server ready at http://localhost:${port}/graphql`);
    });
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
};

startServer();
