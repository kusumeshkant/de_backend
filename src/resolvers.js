const { GraphQLError } = require('graphql');
const { getOrCreateUser, getProfile, updateProfile, updateFcmToken, getAllStaff, updateUserRole, getUserByEmail } = require('./services/userService');
const { sendOrderConfirmation, sendOrderStatusUpdate } = require('./services/notificationService');
const { getProductByBarcode, getStoreProducts, createProduct, updateProduct, deleteProduct } = require('./services/productService');
const { getStores, getStoreById, getNearbyStores, createStore, updateStore, deleteStore } = require('./services/storeService');
const { createOrder, getMyOrders, getOrderById, getStoreOrders, getOrderByIdForStaff, updateOrderStatus, flagOrderIssue, getAllOrders, getDashboardStats, getStoreStats } = require('./services/orderService');
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

    stores: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        if (user.storeId) {
          const store = await getStoreById(user.storeId.toString());
          return store ? [store] : [];
        }
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

    nearbyStores: async (_, { lat, lon }, context) => {
      requireAuth(context);
      try {
        return await getNearbyStores(lat, lon, 2);
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

    storeOrders: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        return await getStoreOrders(storeId);
      } catch (error) {
        logger.error(`storeOrders error: ${error.message}`);
        throw error;
      }
    },

    orderById: async (_, { orderId }, context) => {
      requireAuth(context);
      try {
        return await getOrderByIdForStaff(orderId);
      } catch (error) {
        logger.error(`orderById error: ${error.message}`);
        throw error;
      }
    },

    allOrders: async (_, { storeId, status }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : storeId;
        return await getAllOrders({ storeId: effectiveStoreId, status });
      } catch (error) {
        logger.error(`allOrders error: ${error.message}`);
        throw error;
      }
    },

    dashboardStats: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        if (user.storeId) {
          const stats = await getStoreStats(user.storeId.toString());
          return {
            totalRevenue: stats.totalRevenue,
            totalOrders: stats.totalOrders,
            pendingOrders: stats.pendingOrders,
            completedOrders: stats.completedOrders,
            activeStores: 1,
            topStores: stats.store
              ? [{ store: stats.store, revenue: stats.totalRevenue, orderCount: stats.totalOrders }]
              : [],
            recentOrders: stats.recentOrders,
          };
        }
        return await getDashboardStats();
      } catch (error) {
        logger.error(`dashboardStats error: ${error.message}`);
        throw error;
      }
    },

    storeStats: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        return await getStoreStats(storeId);
      } catch (error) {
        logger.error(`storeStats error: ${error.message}`);
        throw error;
      }
    },

    allStaff: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : null;
        return await getAllStaff(effectiveStoreId);
      } catch (error) {
        logger.error(`allStaff error: ${error.message}`);
        throw error;
      }
    },

    userByEmail: async (_, { email }, context) => {
      requireAuth(context);
      try {
        return await getUserByEmail(email);
      } catch (error) {
        logger.error(`userByEmail error: ${error.message}`);
        throw error;
      }
    },

    storeProducts: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        return await getStoreProducts(storeId);
      } catch (error) {
        logger.error(`storeProducts error: ${error.message}`);
        throw error;
      }
    },
  },

  Mutation: {
    updateProfile: async (_, { name, phone, email }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        return await updateProfile(user._id, { name, phone, email });
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
        const staffUser = await getOrCreateUser(context.user);
        const order = await updateOrderStatus(
          orderId,
          status,
          staffUser._id.toString(),
          staffUser.name ?? 'Staff'
        );

        // Look up customer's FCM token to send status push
        const User = require('./models/User');
        const customer = await User.findById(order._userId);
        if (customer?.fcmToken) {
          sendOrderStatusUpdate(customer.fcmToken, {
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

    flagOrderIssue: async (_, { orderId, reason, note }, context) => {
      requireAuth(context);
      try {
        const staffUser = await getOrCreateUser(context.user);
        return await flagOrderIssue(
          orderId,
          reason,
          note ?? '',
          staffUser._id.toString(),
          staffUser.name ?? 'Staff'
        );
      } catch (error) {
        logger.error(`flagOrderIssue error: ${error.message}`);
        throw error;
      }
    },

    createStore: async (_, { name, address, lat, lon, storeCode }, context) => {
      requireAuth(context);
      try {
        return await createStore({ name, address, lat, lon, storeCode });
      } catch (error) {
        logger.error(`createStore error: ${error.message}`);
        throw error;
      }
    },

    updateStore: async (_, { id, name, address, lat, lon, storeCode }, context) => {
      requireAuth(context);
      try {
        return await updateStore(id, { name, address, lat, lon, storeCode });
      } catch (error) {
        logger.error(`updateStore error: ${error.message}`);
        throw error;
      }
    },

    deleteStore: async (_, { id }, context) => {
      requireAuth(context);
      try {
        return await deleteStore(id);
      } catch (error) {
        logger.error(`deleteStore error: ${error.message}`);
        throw error;
      }
    },

    createProduct: async (_, { storeId, barcode, sku, name, description, price, stock }, context) => {
      requireAuth(context);
      try {
        return await createProduct({ storeId, barcode, sku, name, description, price, stock });
      } catch (error) {
        logger.error(`createProduct error: ${error.message}`);
        throw error;
      }
    },

    updateProduct: async (_, { id, sku, name, description, price, stock }, context) => {
      requireAuth(context);
      try {
        return await updateProduct(id, { sku, name, description, price, stock });
      } catch (error) {
        logger.error(`updateProduct error: ${error.message}`);
        throw error;
      }
    },

    deleteProduct: async (_, { id }, context) => {
      requireAuth(context);
      try {
        return await deleteProduct(id);
      } catch (error) {
        logger.error(`deleteProduct error: ${error.message}`);
        throw error;
      }
    },

    updateUserRole: async (_, { userId, role, storeId }, context) => {
      requireAuth(context);
      try {
        return await updateUserRole(userId, role, storeId);
      } catch (error) {
        logger.error(`updateUserRole error: ${error.message}`);
        throw error;
      }
    },
  },

  Order: {
    id: (order) => order._id.toString(),
    createdAt: (order) => order.createdAt.toISOString(),
    storeName: (order) => order._storeName ?? null,
    storeCode: (order) => order._storeCode ?? null,
    staffActions: (order) =>
      (order.staffActions ?? []).map((a) => ({
        ...a,
        timestamp: a.timestamp instanceof Date ? a.timestamp.toISOString() : a.timestamp,
      })),
    flaggedIssue: (order) => {
      if (!order.flaggedIssue) return null;
      const f = order.flaggedIssue;
      return {
        ...f.toObject?.() ?? f,
        timestamp: f.timestamp instanceof Date ? f.timestamp.toISOString() : f.timestamp,
      };
    },
  },

  User: {
    id: (user) => user._id.toString(),
    storeId: (user) => user.storeId?.toString() ?? null,
  },

  Product: {
    id: (product) => product._id.toString(),
    storeId: (product) => product.storeId?.toString() ?? null,
  },

  Store: {
    id: (store) => store._id.toString(),
    distanceKm: (store) => store.distanceKm ?? null,
  },

  StoreRevenue: {
    store: (sr) => sr.store,
  },

  StoreStats: {
    store: (ss) => ss.store,
  },
};

module.exports = resolvers;
