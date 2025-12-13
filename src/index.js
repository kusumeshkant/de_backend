require('dotenv').config();
const { ApolloServer } = require('apollo-server');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const typeDefs = require('./schema/typeDefs');
const resolvers = require('./resolvers');
const logger = require('./utils/logger');

const startServer = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info('Connected to MongoDB');

    // Initialize Apollo Server
    const server = new ApolloServer({
      typeDefs,
      resolvers,
      context: ({ req }) => {
        const token = req.headers.authorization || '';
        let user = null;
        if (token) {
          try {
            user = jwt.verify(token, process.env.JWT_SECRET);
          } catch (err) {
            logger.error('Invalid token');
          }
        }
        return { req, user };
      },
    });

    // Start the server
    const { url } = await server.listen({ port: process.env.PORT || 4000 });
    logger.info(`Server is running at ${url}`);
  } catch (error) {
    logger.error(`Error starting the server: ${error.message}`);
  }
};

startServer();