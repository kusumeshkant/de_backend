const { GraphQLError } = require('graphql');
const { getOrCreateUser } = require('./services/userService');
const { getProductByBarcode } = require('./services/productService');
const { getStores, getStoreById } = require('./services/storeService');
const { createOrder, getMyOrders, getOrderById } = require('./services/orderService');
const logger = require('./utils/logger');

function requireAuth(context) {
  if (!context.user) {
    throw new GraphQLError('You must be logged in', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
}

const resolvers = {
  Query: {
    productByBarcode: async (_, { barcode }) => {
      try {
        return await getProductByBarcode(barcode);
      } catch (error) {
        logger.error(`productByBarcode error: ${error.message}`);
        throw error;
      }
    },

    stores: async () => {
      try {
        return await getStores();
      } catch (error) {
        logger.error(`stores error: ${error.message}`);
        throw error;
      }
    },

    store: async (_, { id }) => {
      try {
        return await getStoreById(id);
      } catch (error) {
        logger.error(`store error: ${error.message}`);
        throw error;
      }
    },

    myOrders: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        return await getMyOrders(user._id);
      } catch (error) {
        logger.error(`myOrders error: ${error.message}`);
        throw error;
      }
    },

    order: async (_, { id }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        return await getOrderById(id, user._id);
      } catch (error) {
        logger.error(`order error: ${error.message}`);
        throw error;
      }
    },
  },

  Mutation: {
    createOrder: async (_, args, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        const order = await createOrder({ userId: user._id, ...args });
        logger.info(`Order created: ${order._id}`);
        return order;
      } catch (error) {
        logger.error(`createOrder error: ${error.message}`);
        throw error;
      }
    },
  },

  // Map MongoDB _id to GraphQL id
  Order: {
    id: (order) => order._id.toString(),
    createdAt: (order) => order.createdAt.toISOString(),
    storeName: (order) => order._storeName ?? null,
  },

  Product: {
    id: (product) => product._id.toString(),
  },

  Store: {
    id: (store) => store._id.toString(),
  },
};

module.exports = resolvers;
