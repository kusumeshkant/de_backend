require('dotenv').config();

const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const mongoose = require('mongoose');
const typeDefs = require('./schema/typeDefs');
const resolvers = require('./resolvers');
const { verifyToken } = require('./middleware/auth');
const logger = require('./utils/logger');
const { setEnv } = require('./services/notificationService_cf');

const startServer = async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

    // Provide env vars to the CF-compatible notification service
    setEnv(process.env);

    await mongoose.connect(process.env.MONGO_URI);
    logger.info('Connected to MongoDB');

    const server = new ApolloServer({ typeDefs, resolvers });

    const port = Number(process.env.PORT) || 4000;

    const { url } = await startStandaloneServer(server, {
      context: async ({ req }) => {
        const user = await verifyToken(req);
        return { user };
      },
      listen: { port },
    });

    logger.info(`GraphQL server ready at ${url}`);
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
};

startServer();
