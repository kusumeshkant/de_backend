const { GraphQLError } = require('graphql');
const { getOrCreateUser, getProfile, updateProfile, updateFcmToken } = require('./services/userService');
const { sendOrderConfirmation, sendOrderStatusUpdate } = require('./services/notificationService');
const { getProductByBarcode } = require('./services/productService');
const { getStores, getStoreById, getNearbyStores } = require('./services/storeService');
const { createOrder, getMyOrders, getOrderById, updateOrderStatus } = require('./services/orderService');
const { createRazorpayOrder, verifyPayment } = require('./services/razorpayService');
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
    productByBarcode: async (_, { barcode, storeId }) => {
      try {
        return await getProductByBarcode(barcode, storeId);
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

    nearbyStores: async (_, { lat, lon }) => {
      try {
        return await getNearbyStores(lat, lon);
      } catch (error) {
        logger.error(`nearbyStores error: ${error.message}`);
        throw error;
      }
    },

    me: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        return await getProfile(user._id);
      } catch (error) {
        logger.error(`me error: ${error.message}`);
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
    updateProfile: async (_, { name }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        return await updateProfile(user._id, { name });
      } catch (error) {
        logger.error(`updateProfile error: ${error.message}`);
        throw error;
      }
    },

    updateFcmToken: async (_, { token }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        await updateFcmToken(user._id, token);
        return true;
      } catch (error) {
        logger.error(`updateFcmToken error: ${error.message}`);
        return false;
      }
    },

    createRazorpayOrder: async (_, { amount }, context) => {
      requireAuth(context);
      try {
        return await createRazorpayOrder(amount);
      } catch (error) {
        logger.error(`createRazorpayOrder error: ${error.message}`);
        throw error;
      }
    },

    createOrder: async (_, args, context) => {
      requireAuth(context);
      try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature, ...orderArgs } = args;

        const isValid = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);
        if (!isValid) {
          throw new GraphQLError('Payment verification failed', {
            extensions: { code: 'PAYMENT_VERIFICATION_FAILED' },
          });
        }

        const user = await getOrCreateUser(context.user);
        const order = await createOrder({
          userId: user._id,
          razorpayOrderId,
          razorpayPaymentId,
          ...orderArgs,
        });
        logger.info(`Order created: ${order._id}`);

        // Send push notification (non-blocking)
        sendOrderConfirmation(user.fcmToken, {
          grandTotal: order.grandTotal,
          storeName: order._storeName,
        }).catch(() => {});

        return order;
      } catch (error) {
        logger.error(`createOrder error: ${error.message}`);
        throw error;
      }
    },

    updateOrderStatus: async (_, { orderId, status }, context) => {
      requireAuth(context);
      try {
        const order = await updateOrderStatus(orderId, status);

        // Look up user's FCM token to send status push
        const User = require('./models/User');
        const user = await User.findById(order._userId);
        if (user?.fcmToken) {
          sendOrderStatusUpdate(user.fcmToken, {
            status,
            storeName: order._storeName,
          }).catch(() => {});
        }

        return order;
      } catch (error) {
        logger.error(`updateOrderStatus error: ${error.message}`);
        throw error;
      }
    },
  },

  // Map MongoDB _id to GraphQL id
  User: {
    id: (user) => user._id.toString(),
  },

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
    distanceKm: (store) => store.distanceKm ?? null,
  },
};

module.exports = resolvers;
