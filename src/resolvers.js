const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const { ErrorHandler } = require('./utils/errorHandler');
const { registerUser, loginUser } = require('./services/userService');
const { addProduct, getProducts } = require('./services/productService');
const { createOrder, getOrders } = require('./services/orderService');

const resolvers = {
  Query: {
    users: async () => await User.find(),
    products: async () => await getProducts(),
    orders: async () => await getOrders(),
  },
  Mutation: {
    register: async (_, args) => await registerUser(args),
    login: async (_, args) => await loginUser(args),
    addProduct: async (_, args) => await addProduct(args),
    createOrder: async (_, args, context) => {
      if (!context.user) {
        throw new ErrorHandler('Unauthorized', 401);
      }
      return await createOrder({ userId: context.user.id, ...args });
    },
  },
};

module.exports = resolvers;