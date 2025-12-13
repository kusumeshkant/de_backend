const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const { ErrorHandler } = require('./utils/errorHandler');
const { registerUser, loginUser } = require('./services/userService');
const { addProduct, getProducts } = require('./services/productService');
const { createOrder, getOrders } = require('./services/orderService');
const logger = require('./utils/logger');

const resolvers = {
  Query: {
    users: async () => await User.find(),
    products: async () => await getProducts(),
    orders: async () => await getOrders(),
  },
  Mutation: {
    register: async (_, args) => {
      try {
        const user = await registerUser(args);
        logger.info(`User registered: ${user.email}`);
        return user;
      } catch (error) {
        logger.error(`Registration error: ${error.message}`);
        throw error;
      }
    },
    login: async (_, args) => {
      try {
        const token = await loginUser(args);
        logger.info(`User logged in: ${args.email}`);
        return token;
      } catch (error) {
        logger.error(`Login error: ${error.message}`);
        throw error;
      }
    },
    addProduct: async (_, args) => {
      try {
        const product = await addProduct(args);
        logger.info(`Product added: ${product.name}`);
        return product;
      } catch (error) {
        logger.error(`Add product error: ${error.message}`);
        throw error;
      }
    },
    createOrder: async (_, args, context) => {
      try {
        if (!context.user) {
          throw new ErrorHandler('Unauthorized', 401);
        }
        const order = await createOrder({ userId: context.user.id, ...args });
        logger.info(`Order created: ${order.id}`);
        return order;
      } catch (error) {
        logger.error(`Create order error: ${error.message}`);
        throw error;
      }
    },
  },
};

module.exports = resolvers;