const { GraphQLError } = require('graphql');
const { Roles, AppId, RoleHint, RoleGroups } = require('./constants/roles');
const { PLAN_LIMITS } = require('./constants/feature_keys');
const { getOrCreateUser, getProfile, updateProfile, updateFcmToken, getAllStaff, getStaffPaginated, updateUserRole, upgradeToAdmin, getUserByEmail, ensureCustomerRole } = require('./services/userService');
const { inviteStaff, bulkInviteStaff, validateInviteToken, acceptInvite, getStoreStaff, removeStaff, getPendingInvites, cancelInvite } = require('./services/inviteService');
const { sendOrderConfirmation, sendOrderStatusUpdate, sendNewOrderToStaff, sendPermissionRequestNotification, sendPermissionStatusNotification } = require('./services/notificationService_cf');
const { getProductByBarcode, getStoreProducts, getProductsPaginated, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, getUploadLogs } = require('./services/productService');
const { getStores, getStoreById, getNearbyStores, createStore, updateStore, deleteStore, getStoresPaginated } = require('./services/storeService');
const { createOrder, getMyOrders, getOrderById, getStoreOrders, getOrderByIdForStaff, updateOrderStatus, flagOrderIssue, getAllOrders, getOrdersPaginated, getDashboardStats, getStoreStats, validateCartStock, getStoreAnalytics, getCustomerRetention, getStaffPerformance, getBasketAbandonmentStats, getCustomerLTV, getMonthlyRevenue } = require('./services/orderService');
const { createRazorpayOrder, verifyPayment } = require('./services/razorpayService');
const { requestPermission, getPendingRequests, getAllRequests, getMyRequests, approveRequest, rejectRequest, revokePermission, getStaffPermissions, checkPermission } = require('./services/permissionService');
const { generateDiscountCode, validateDiscountCode, consumeDiscountCode, getDiscountLogs } = require('./services/discountService');
const { logProductCreate, logProductUpdate, logProductDelete, getProductChangeLogs } = require('./services/auditLogService');
const Product = require('./models/Product');
const {
  getStoreSubscription,
  getAvailablePlans,
  activatePlan,
  cancelSubscription,
  setAdminOverride,
} = require('./services/subscription_service');
const { getFeatureAccessMap } = require('./services/feature_access_service');
const { getRemainingUsage, assertLimitNotReached, refreshUsageCounters } = require('./services/plan_limit_service');
const logger = require('./utils/logger_cf');

// â”€â”€ Auth helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Request context shape (set by index.js):
//   context.user   â€” Firebase identity { uid, email, phone } | null
//   context.dbUser â€” MongoDB User doc  { _id, roles, ... }  | null
//
// Call order in every protected resolver:
//   1. requireAuth(context)   â€” verifies Firebase token was valid
//   2. requireDbUser(context) â€” verifies user exists in MongoDB
//   3. requireRole(...)       â€” verifies the user holds a required role

/** Throws UNAUTHENTICATED if no valid Firebase token was present in the request. */
function requireAuth(context) {
  if (!context.user) {
    throw new GraphQLError('You must be logged in', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
}

/**
 * Returns context.dbUser, or throws UNAUTHENTICATED if the MongoDB user
 * document was not found.
 *
 * This can happen if:
 *   - The user authenticated with Firebase but never called validateAppAccess
 *     (which creates the document on first login).
 *   - The MongoDB document was manually deleted.
 *
 * In both cases the correct response is to ask the user to log in again.
 *
 * @returns {Object} The MongoDB User document (lean plain object)
 */
function requireDbUser(context) {
  if (!context.dbUser) {
    throw new GraphQLError('Account not found. Please log in again.', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return context.dbUser;
}

/** Returns true if *user* (MongoDB doc) holds ANY of the given roles. */
function hasRole(user, ...roles) {
  return roles.some(r => user.roles?.includes(r));
}

/**
 * Throws FORBIDDEN if *user* does not hold at least one of the given roles.
 * Logs the rejection for the audit trail.
 *
 * @param {Object} user - MongoDB User document
 * @param {...string} roles - Roles.CUSTOMER | Roles.STAFF | Roles.ADMIN
 */
function requireRole(user, ...roles) {
  if (!hasRole(user, ...roles)) {
    const required = roles.join(' or ');
    logger.warn(
      `RBAC denied: uid=${user.firebase_uid} has [${user.roles}], needs [${required}]`
    );
    throw new GraphQLError(`This operation requires ${required} access`, {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

// â”€â”€ Resolvers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const resolvers = {
  Query: {

    // â”€â”€ Public (no auth required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Only store discovery queries are public â€” they contain no sensitive data.

    // â”€â”€ Authenticated â€” any logged-in role â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // productByBarcode requires auth to prevent unauthenticated inventory scraping.
    // Any valid Firebase session is accepted (customer, staff, or admin).
    productByBarcode: async (_, { barcode, storeId }, context) => {
      requireAuth(context);
      try {
        return await getProductByBarcode(barcode, storeId);
      } catch (error) {
        logger.error(`productByBarcode error: ${error.message}`);
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
        return await getNearbyStores(lat, lon, 2);
      } catch (error) {
        logger.error(`nearbyStores error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Any authenticated role â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    // Pattern for all protected resolvers (replaces the old getOrCreateUser() call):
    //
    //   requireAuth(context);          â€” Firebase token was valid
    //   const dbUser = requireDbUser(context);  â€” MongoDB doc pre-loaded in context
    //   requireRole(dbUser, Roles.X);  â€” role check if needed
    //
    // context.dbUser is loaded once per request in index.js. No extra DB query needed.

    me: async (_, __, context) => {
      requireAuth(context);
      const dbUser = requireDbUser(context);
      try {
        // getProfile fetches the full Mongoose document (with virtuals).
        // context.dbUser is a lean() plain object â€” suitable for role checks,
        // but use the full document when you need Mongoose methods or virtuals.
        return await getProfile(dbUser._id);
      } catch (error) {
        logger.error(`me error: ${error.message}`);
        throw error;
      }
    },

    /**
     * App-specific login gate â€” must be called once on login and cold start.
     *
     * appId values: "CUSTOMER" | "STAFF" | "ADMIN"
     *
     * CUSTOMER: rejects admin and staff accounts (must use their own apps).
     *           Auto-creates a customer record on first login (new registration path).
     * STAFF:    rejects accounts without staff or admin role.
     * ADMIN:    rejects accounts without admin role.
     *
     * Returns the authenticated User on success, throws FORBIDDEN on failure.
     */
    validateAppAccess: async (_, { appId }, context) => {
      requireAuth(context);
      try {
        const User = require('./models/User');
        let user;

        if (appId === AppId.CUSTOMER) {
          // Step 1: look up the user WITHOUT auto-creating first.
          // This prevents a staff-invited user (whose firebase_uid exists in
          // MongoDB as staff-only) from being silently created as a customer
          // on their first DQ App login.
          user = await User.findOne({ firebase_uid: context.user.uid });

          if (user) {
            // Strict separation: one account, one app. Admin and staff accounts
            // cannot be used to shop â€” they must register a separate customer account.
            if (hasRole(user, Roles.ADMIN)) {
              throw new GraphQLError(
                'This account is registered as a store admin. Admin and customer accounts must be separate â€” please use a different account to shop on DQ.',
                { extensions: { code: 'FORBIDDEN', hint: RoleHint.ADMIN_NO_CUSTOMER } }
              );
            }
            if (hasRole(user, Roles.STAFF)) {
              throw new GraphQLError(
                'This account is registered as a store staff member. Staff and customer accounts must be separate â€” please use a different account to shop on DQ.',
                { extensions: { code: 'FORBIDDEN', hint: RoleHint.STAFF_NO_CUSTOMER } }
              );
            }
            if (!hasRole(user, Roles.CUSTOMER)) {
              throw new GraphQLError(
                'This account does not have customer access. Please sign up on the DQ App to shop.',
                { extensions: { code: 'FORBIDDEN', hint: RoleHint.NO_CUSTOMER } }
              );
            }
            // user has customer role and no conflicting roles â€” allowed
          } else {
            // First-ever login to DQ App â€” safe to auto-create as customer.
            const newCustomer = await getOrCreateUser(context.user);
            user = newCustomer;
          }

        } else if (appId === AppId.STAFF) {
          // Staff must have registered through the invite flow first.
          user = await User.findOne({ firebase_uid: context.user.uid });
          if (!user) {
            throw new GraphQLError(
              'No staff account found for this ID. Please register and accept your store invite.',
              { extensions: { code: 'NOT_FOUND' } }
            );
          }
          if (!hasRole(user, Roles.STAFF, Roles.ADMIN)) {
            if (hasRole(user, Roles.CUSTOMER)) {
              throw new GraphQLError(
                'This account is registered as a customer on DQ App. Customer and staff accounts must be separate â€” please use a different account for staff access.',
                { extensions: { code: 'FORBIDDEN', hint: 'CUSTOMER_NO_STAFF' } }
              );
            }
            throw new GraphQLError(
              'Access denied. Contact your store admin to get staff access.',
              { extensions: { code: 'FORBIDDEN' } }
            );
          }

        } else if (appId === AppId.ADMIN) {
          // Admins must have registered through the dq_admin signup flow first.
          user = await User.findOne({ firebase_uid: context.user.uid });
          if (!user) {
            throw new GraphQLError(
              'No admin account found for this ID. Please sign up using the DQ Admin app.',
              { extensions: { code: 'FORBIDDEN', hint: 'NO_ACCOUNT' } }
            );
          }
          if (!hasRole(user, Roles.ADMIN)) {
            if (hasRole(user, Roles.CUSTOMER)) {
              throw new GraphQLError(
                'This account is registered as a customer on DQ App. Customer and admin accounts must be separate â€” please use a different account to sign up as an admin.',
                { extensions: { code: 'FORBIDDEN', hint: 'CUSTOMER_NO_ADMIN' } }
              );
            }
            if (hasRole(user, Roles.STAFF)) {
              throw new GraphQLError(
                'This account is registered as a store staff member. Staff and admin accounts must be separate â€” please use a different account to sign up as an admin.',
                { extensions: { code: 'FORBIDDEN', hint: 'STAFF_NO_ADMIN' } }
              );
            }
            throw new GraphQLError(
              'This account does not have admin access. Please sign up via the DQ Admin app.',
              { extensions: { code: 'FORBIDDEN', hint: 'NO_ADMIN' } }
            );
          }

        } else {
          throw new GraphQLError(`Unknown appId: ${appId}`, {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }

        logger.info(`validateAppAccess: uid=${context.user.uid} appId=${appId} roles=[${user.roles}] GRANTED`);
        return await getProfile(user._id);
      } catch (error) {
        if (['FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT'].includes(error.extensions?.code)) throw error;
        logger.error(`validateAppAccess error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Staff + Admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    stores: async (_, __, context) => {
      requireAuth(context);
      const dbUser = requireDbUser(context);
      requireRole(dbUser, Roles.STAFF, Roles.ADMIN);
      try {
        if (dbUser.storeId) {
          const store = await getStoreById(dbUser.storeId.toString());
          return store ? [store] : [];
        }
        return await getStores();
      } catch (error) {
        logger.error(`stores error: ${error.message}`);
        throw error;
      }
    },

    storeOrders: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF, Roles.ADMIN);
        // Ownership check: staff/admin may only query orders for their own store.
        // Without this, a compromised staff account at Store A could exfiltrate
        // the full order history of Store B by supplying a different storeId.
        if (!user.storeId || user.storeId.toString() !== storeId.toString()) {
          throw new GraphQLError('Access denied: you do not belong to this store', {
            extensions: { code: 'FORBIDDEN' },
          });
        }
        return await getStoreOrders(storeId);
      } catch (error) {
        logger.error(`storeOrders error: ${error.message}`);
        throw error;
      }
    },

    orderById: async (_, { orderId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF, Roles.ADMIN);
        return await getOrderByIdForStaff(orderId);
      } catch (error) {
        logger.error(`orderById error: ${error.message}`);
        throw error;
      }
    },

    storeProducts: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF, Roles.ADMIN);
        return await getStoreProducts(storeId);
      } catch (error) {
        logger.error(`storeProducts error: ${error.message}`);
        throw error;
      }
    },

    storeProductsPaginated: async (_, { storeId, first, after, search, sortBy, sortDir, filters }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await getProductsPaginated(storeId, { first, after, search, sortBy, sortDir, filters });
      } catch (error) {
        logger.error(`storeProductsPaginated error: ${error.message}`);
        throw error;
      }
    },

    validateInviteToken: async (_, { token }, context) => {
      requireAuth(context);
      try {
        return await validateInviteToken(token);
      } catch (error) {
        logger.error(`validateInviteToken error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Admin only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    allOrders: async (_, { storeId, status }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : storeId;
        return await getAllOrders({ storeId: effectiveStoreId, status });
      } catch (error) {
        logger.error(`allOrders error: ${error.message}`);
        throw error;
      }
    },

    allOrdersPaginated: async (_, { first, after, search, storeId, status }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : storeId;
        return await getOrdersPaginated({ storeId: effectiveStoreId, first, after, search, filters: status ? { status } : {} });
      } catch (error) {
        logger.error(`allOrdersPaginated error: ${error.message}`);
        throw error;
      }
    },

    allStaffPaginated: async (_, { first, after, search, storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : storeId;
        return await getStaffPaginated({ first, after, search, storeId: effectiveStoreId });
      } catch (error) {
        logger.error(`allStaffPaginated error: ${error.message}`);
        throw error;
      }
    },

    storesPaginated: async (_, { first, after, search, storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : storeId;
        return await getStoresPaginated({ first, after, search, storeId: effectiveStoreId });
      } catch (error) {
        logger.error(`storesPaginated error: ${error.message}`);
        throw error;
      }
    },

    dashboardStats: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        if (user.storeId) {
          const stats = await getStoreStats(user.storeId.toString());
          const now = new Date();
          const startOfThisWeek = new Date(now);
          startOfThisWeek.setDate(now.getDate() - now.getDay());
          startOfThisWeek.setHours(0, 0, 0, 0);
          const startOfLastWeek = new Date(startOfThisWeek);
          startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
          const thisWeekOrders = stats.recentOrders.filter((o) => new Date(o.createdAt) >= startOfThisWeek).length;
          const lastWeekOrders = stats.recentOrders.filter((o) => {
            const d = new Date(o.createdAt);
            return d >= startOfLastWeek && d < startOfThisWeek;
          }).length;
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
            thisWeekOrders,
            lastWeekOrders,
            orderGrowthRate: lastWeekOrders > 0 ? ((thisWeekOrders - lastWeekOrders) / lastWeekOrders) * 100 : null,
            thisWeekRevenue: 0,
            lastWeekRevenue: 0,
            revenueGrowthRate: null,
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
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await getStoreStats(storeId);
      } catch (error) {
        logger.error(`storeStats error: ${error.message}`);
        throw error;
      }
    },

    allStaff: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : null;
        return await getAllStaff(effectiveStoreId);
      } catch (error) {
        logger.error(`allStaff error: ${error.message}`);
        throw error;
      }
    },

    storeStaff: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await getStoreStaff(storeId);
      } catch (error) {
        logger.error(`storeStaff error: ${error.message}`);
        throw error;
      }
    },

    pendingInvites: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await getPendingInvites(storeId);
      } catch (error) {
        logger.error(`pendingInvites error: ${error.message}`);
        throw error;
      }
    },

    userByEmail: async (_, { email }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await getUserByEmail(email);
      } catch (error) {
        logger.error(`userByEmail error: ${error.message}`);
        throw error;
      }
    },

    validateCartStock: async (_, { storeId, items }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.CUSTOMER);
        return await validateCartStock(storeId, items, user._id);
      } catch (error) {
        logger.error(`validateCartStock error: ${error.message}`);
        throw error;
      }
    },

    storeAnalytics: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : (storeId ?? null);
        return await getStoreAnalytics(effectiveStoreId);
      } catch (error) {
        logger.error(`storeAnalytics error: ${error.message}`);
        throw error;
      }
    },

    basketAbandonment: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : (storeId ?? null);
        return await getBasketAbandonmentStats(effectiveStoreId);
      } catch (error) {
        logger.error(`basketAbandonment error: ${error.message}`);
        throw error;
      }
    },

    customerLTV: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : (storeId ?? null);
        return await getCustomerLTV(effectiveStoreId);
      } catch (error) {
        logger.error(`customerLTV error: ${error.message}`);
        throw error;
      }
    },

    monthlyRevenue: async (_, { storeId, year }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : (storeId ?? null);
        return await getMonthlyRevenue(effectiveStoreId, year ?? null);
      } catch (error) {
        logger.error(`monthlyRevenue error: ${error.message}`);
        throw error;
      }
    },

    staffPerformance: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : (storeId ?? null);
        return await getStaffPerformance(effectiveStoreId);
      } catch (error) {
        logger.error(`staffPerformance error: ${error.message}`);
        throw error;
      }
    },

    customerRetention: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const effectiveStoreId = user.storeId ? user.storeId.toString() : (storeId ?? null);
        return await getCustomerRetention(effectiveStoreId);
      } catch (error) {
        logger.error(`customerRetention error: ${error.message}`);
        throw error;
      }
    },

    uploadLogs: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const logs = await getUploadLogs(storeId);
        return logs.map((l) => ({
          ...l,
          id: l._id.toString(),
          storeId: l.storeId?.toString(),
          uploadedBy: l.uploadedBy?.toString() ?? null,
          uploadedAt: l.createdAt?.toISOString(),
        }));
      } catch (error) {
        logger.error(`uploadLogs error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Customer only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // ── Staff only (read) ───────────────────────────────────────────────────────────

    myPermissions: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF);
        const p = await getStaffPermissions(user._id, storeId);
        return { ...p, id: p._id?.toString() || null, staffId: p.staffId?.toString() || user._id.toString(), storeId: p.storeId?.toString() || storeId, grantedAt: p.grantedAt?.toISOString() || null };
      } catch (error) { logger.error(); throw error; }
    },

    myPermissionRequests: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF);
        const reqs = await getMyRequests(user._id, storeId);
        return reqs.map(_formatRequest);
      } catch (error) { logger.error(); throw error; }
    },

    // ── Admin only (read) ───────────────────────────────────────────────────────────

    pendingPermissionRequests: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const reqs = await getPendingRequests(storeId);
        return reqs.map(_formatRequest);
      } catch (error) { logger.error(); throw error; }
    },

    allPermissionRequests: async (_, { storeId, status }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const reqs = await getAllRequests(storeId, { status });
        return reqs.map(_formatRequest);
      } catch (error) { logger.error(); throw error; }
    },

    staffPermissions: async (_, { staffId, storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const p = await getStaffPermissions(staffId, storeId);
        return { ...p, id: p._id?.toString() || null, staffId: p.staffId?.toString() || staffId, storeId: p.storeId?.toString() || storeId, grantedAt: p.grantedAt?.toISOString() || null };
      } catch (error) { logger.error(); throw error; }
    },

    discountLogs: async (_, { storeId, limit, offset }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const logs = await getDiscountLogs(storeId, { limit, offset });
        return logs.map(l => ({ ...l, id: l._id.toString(), orderId: l.orderId?.toString(), staffId: l.staffId?.toString(), appliedAt: l.appliedAt?.toISOString() }));
      } catch (error) { logger.error(); throw error; }
    },

    productChangeLogs: async (_, { storeId, limit, offset }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const logs = await getProductChangeLogs(storeId, { limit, offset });
        return logs.map(l => ({
          ...l,
          id:         l._id.toString(),
          productId:  l.productId?.toString() || null,
          storeId:    l.storeId?.toString(),
          oldValues:  l.oldValues  ? JSON.stringify(l.oldValues)  : null,
          newValues:  l.newValues  ? JSON.stringify(l.newValues)  : null,
          createdAt:  l.createdAt?.toISOString(),
        }));
      } catch (error) { logger.error(); throw error; }
    },

    myOrders: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.CUSTOMER);
        return await getMyOrders(user._id);
      } catch (error) {
        logger.error(`myOrders error: ${error.message}`);
        throw error;
      }
    },

    order: async (_, { id }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.CUSTOMER);
        return await getOrderById(id, user._id);
      } catch (error) {
        logger.error(`order error: ${error.message}`);
        throw error;
      }
    },
  },

  // â”€â”€ Mutations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  Mutation: {

    // â”€â”€ Any authenticated user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Called by the DQ App (customer app) signup flow when a staff or admin
     * Google account wants to also shop as a customer.
     *
     * Adds 'customer' to the roles array without touching existing roles.
     * Customer is the lowest-privilege role â€” no guard beyond authentication
     * is needed. Idempotent: safe to call even if already a customer.
     */
    registerAsCustomer: async (_, __, context) => {
      requireAuth(context);
      try {
        const User = require('./models/User');
        const user = await User.findOne({ firebase_uid: context.user.uid });
        if (!user) {
          // First-ever login â€” create as customer
          const newCustomer = await getOrCreateUser(context.user);
          return await getProfile(newCustomer._id);
        }
        if (hasRole(user, Roles.ADMIN)) {
          throw new GraphQLError(
            'This account is registered as a store admin. Admin and customer accounts must be separate â€” please use a different account to shop on DQ.',
            { extensions: { code: 'FORBIDDEN', hint: 'ADMIN_NO_CUSTOMER' } }
          );
        }
        if (hasRole(user, Roles.STAFF)) {
          throw new GraphQLError(
            'This account is registered as a store staff member. Staff and customer accounts must be separate â€” please use a different account to shop on DQ.',
            { extensions: { code: 'FORBIDDEN', hint: 'STAFF_NO_CUSTOMER' } }
          );
        }
        if (hasRole(user, Roles.CUSTOMER)) {
          return await getProfile(user._id);
        }
        await ensureCustomerRole(user._id);
        logger.info(`registerAsCustomer: uid=${context.user.uid} â€” customer role added`);
        return await getProfile(user._id);
      } catch (error) {
        logger.error(`registerAsCustomer error: ${error.message}`);
        throw error;
      }
    },

    /**
     * Called by dq_admin signup immediately after Firebase account creation.
     * Adds the 'admin' role to the calling user.
     *
     * Guard: only callable if the user has NOT placed any orders (is not an
     * existing customer). Existing customers cannot self-promote to admin.
     */
    registerAdmin: async (_, __, context) => {
      requireAuth(context);
      try {
        const User = require('./models/User');
        const existing = await User.findOne({ firebase_uid: context.user.uid });

        if (existing) {
          if (hasRole(existing, Roles.ADMIN)) return existing; // idempotent
          if (hasRole(existing, Roles.CUSTOMER)) {
            throw new GraphQLError(
              'This account is already registered as a customer on DQ App. Customer and admin accounts must be separate â€” please use a different account to sign up as an admin.',
              { extensions: { code: 'FORBIDDEN', hint: 'CUSTOMER_NO_ADMIN' } }
            );
          }
          if (hasRole(existing, Roles.STAFF)) {
            throw new GraphQLError(
              'This account is already registered as a store staff member. Staff and admin accounts must be separate â€” please use a different account to sign up as an admin.',
              { extensions: { code: 'FORBIDDEN', hint: 'STAFF_NO_ADMIN' } }
            );
          }
          // Account exists but has no conflicting role â€” upgrade directly
          return await upgradeToAdmin(existing._id, existing.storeId);
        }

        // Brand new account â€” create and upgrade to admin
        const newUser = await getOrCreateUser(context.user);
        return await upgradeToAdmin(newUser._id, newUser.storeId);
      } catch (error) {
        logger.error(`registerAdmin error: ${error.message}`);
        throw error;
      }
    },

    updateProfile: async (_, { name, phone, email }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        return await updateProfile(user._id, { name, phone, email });
      } catch (error) {
        logger.error(`updateProfile error: ${error.message}`);
        throw error;
      }
    },

    updateFcmToken: async (_, { token }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        await updateFcmToken(user._id, token);
        return true;
      } catch (error) {
        logger.error(`updateFcmToken error: ${error.message}`);
        return false;
      }
    },

    // acceptInvite is called during staff registration â€” user may only have
    // customer role at this point. After this call, they get staff role.
    acceptInvite: async (_, { token }, context) => {
      requireAuth(context);
      try {
        return await acceptInvite({ token, uid: context.user.uid });
      } catch (error) {
        logger.error(`acceptInvite error: ${error.message}`);
        throw error;
      }
    },

    createRazorpayOrder: async (_, { amount }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.CUSTOMER);
        return await createRazorpayOrder(amount);
      } catch (error) {
        logger.error(`createRazorpayOrder error: ${error.message}`);
        throw error;
      }
    },

    createOrder: async (_, args, context) => {
      requireAuth(context);
      try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature, discountCode, ...orderArgs } = args;

        const isValid = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);
        if (!isValid) {
          throw new GraphQLError('Payment verification failed', {
            extensions: { code: 'PAYMENT_VERIFICATION_FAILED' },
          });
        }

        const user = requireDbUser(context);
        requireRole(user, Roles.CUSTOMER);

        await assertLimitNotReached(args.storeId, PLAN_LIMITS.MAX_ORDERS_PER_MONTH);

        const order = await createOrder({
          userId: user._id,
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature,
          ...orderArgs,
        });
        logger.info(`Order created: ${order._id}`);

        // If a discount code was used, consume it and write the audit log (non-blocking)
        if (discountCode) {
          consumeDiscountCode({
            code:        discountCode,
            storeId:     order.storeId,
            orderId:     order._id,
            grandTotal:  order.grandTotal,
          }).catch(e => logger.error(`consumeDiscountCode failed for order ${order._id}: ${e.message}`));
        }

        sendOrderConfirmation(user.fcmToken, {
          grandTotal: order.grandTotal,
          storeName: order._storeName,
        }).catch(() => {});

        sendNewOrderToStaff(order.storeId, {
          orderId: order._id,
          storeName: order._storeName,
          itemCount: order.items?.length ?? 1,
          grandTotal: order.grandTotal,
        }).catch(() => {});

        refreshUsageCounters(order.storeId).catch(() => {});

        return order;
      } catch (error) {
        logger.error(`createOrder error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Staff + Admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    updateOrderStatus: async (_, { orderId, status }, context) => {
      requireAuth(context);
      try {
        const staffUser = requireDbUser(context);
        requireRole(staffUser, Roles.STAFF, Roles.ADMIN);
        if (staffUser.storeId) {
          const Order = require('./models/Order');
          const existingOrder = await Order.findById(orderId);
          if (!existingOrder || existingOrder.storeId?.toString() !== staffUser.storeId.toString()) {
            throw new GraphQLError('Order does not belong to your store', { extensions: { code: 'FORBIDDEN' } });
          }
        }
        const order = await updateOrderStatus(
          orderId,
          status,
          staffUser._id.toString(),
          staffUser.name ?? 'Staff'
        );

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
        const staffUser = requireDbUser(context);
        requireRole(staffUser, Roles.STAFF, Roles.ADMIN);
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

    // â”€â”€ Admin only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    upgradeToAdmin: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await upgradeToAdmin(user._id, storeId);
      } catch (error) {
        logger.error(`upgradeToAdmin error: ${error.message}`);
        throw error;
      }
    },

    createStore: async (_, { name, address, lat, lon, storeCode }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        // First store is always allowed (no subscription exists yet).
        // For subsequent stores, check MAX_STORES against the existing subscription.
        if (user.storeId) {
          await assertLimitNotReached(user.storeId, PLAN_LIMITS.MAX_STORES);
        }
        return await createStore({ name, address, lat, lon, storeCode }, context.user.uid);
      } catch (error) {
        logger.error(`createStore error: ${error.message}`);
        if (error.code === 11000 && error.keyPattern?.storeCode) {
          throw new GraphQLError(
            `Store code "${storeCode?.trim().toUpperCase() || ''}" is already in use. Please choose a different store code.`,
            { extensions: { code: 'BAD_USER_INPUT' } }
          );
        }
        throw error;
      }
    },

    updateStore: async (_, { id, name, address, lat, lon, storeCode, isActive }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await updateStore(id, { name, address, lat, lon, storeCode, isActive });
      } catch (error) {
        logger.error(`updateStore error: ${error.message}`);
        if (error.code === 11000 && error.keyPattern?.storeCode) {
          throw new GraphQLError(
            `Store code "${storeCode?.trim().toUpperCase() || ''}" is already in use. Please choose a different store code.`,
            { extensions: { code: 'BAD_USER_INPUT' } }
          );
        }
        throw error;
      }
    },

    deleteStore: async (_, { id }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await deleteStore(id);
      } catch (error) {
        logger.error(`deleteStore error: ${error.message}`);
        throw error;
      }
    },

    createProduct: async (_, { storeId, barcode, sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        const isAdmin = hasRole(user, Roles.ADMIN);
        if (!isAdmin) {
          // Staff need explicit canAddProduct permission
          requireRole(user, Roles.STAFF);
          const allowed = await checkPermission(user._id, user.storeId, 'canAddProduct');
          if (!allowed) {
            throw new GraphQLError('You do not have permission to add products. Request access from admin.', { extensions: { code: 'FORBIDDEN' } });
          }
          // Price, stock, mrp are silently overwritten to 0 for staff (admin sets them later).
        }
        const product = await createProduct({ storeId: isAdmin ? storeId : user.storeId, barcode, sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp: isAdmin ? mrp : 0, price: isAdmin ? price : 0, stock: isAdmin ? stock : 0, reorderLevel });
        logProductCreate({ product, changedBy: user._id, changedByName: user.name || 'Unknown', changedByRole: user.role }).catch(() => {});
        return product;
      } catch (error) {
        logger.error(`createProduct error: ${error.message}`);
        throw error;
      }
    },

    updateProduct: async (_, { id, sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel, isAvailable }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        const isAdmin = hasRole(user, Roles.ADMIN);
        if (!isAdmin) {
          requireRole(user, Roles.STAFF);
          const allowed = await checkPermission(user._id, user.storeId, 'canEditProductInfo');
          if (!allowed) {
            throw new GraphQLError('You do not have permission to edit products. Request access from admin.', { extensions: { code: 'FORBIDDEN' } });
          }
          // Price, stock, mrp are excluded from staff updates via the updates object below.
        }
        const oldProduct = await Product.findById(id).lean();
        const updates = isAdmin
          ? { sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel, isAvailable }
          : { sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, isAvailable };
        const product = await updateProduct(id, updates);
        if (oldProduct) {
          logProductUpdate({ productId: id, storeId: oldProduct.storeId, barcode: oldProduct.barcode, oldProduct, updates, changedBy: user._id, changedByName: user.name || 'Unknown', changedByRole: user.role }).catch(() => {});
        }
        return product;
      } catch (error) {
        logger.error(`updateProduct error: ${error.message}`);
        throw error;
      }
    },

    deleteProduct: async (_, { id }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        const isAdmin = hasRole(user, Roles.ADMIN);
        if (!isAdmin) {
          requireRole(user, Roles.STAFF);
          const allowed = await checkPermission(user._id, user.storeId, 'canDeleteProduct');
          if (!allowed) {
            throw new GraphQLError('You do not have permission to delete products. Request access from admin.', { extensions: { code: 'FORBIDDEN' } });
          }
        }
        const oldProduct = await Product.findById(id).lean();
        const result = await deleteProduct(id);
        if (oldProduct) {
          logProductDelete({ product: oldProduct, changedBy: user._id, changedByName: user.name || 'Unknown', changedByRole: user.role }).catch(() => {});
        }
        return result;
      } catch (error) {
        logger.error(`deleteProduct error: ${error.message}`);
        throw error;
      }
    },

    bulkUpsertProducts: async (_, { storeId, products, fileName, totalRows, totalColumns }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        const isAdmin = hasRole(user, Roles.ADMIN);
        if (!isAdmin) {
          requireRole(user, Roles.STAFF);
          const allowed = await checkPermission(user._id, user.storeId, 'canBulkUploadProducts');
          if (!allowed) {
            throw new GraphQLError('You do not have bulk upload permission. Request access from admin.', { extensions: { code: 'FORBIDDEN' } });
          }
        }
        return await bulkUpsertProducts(isAdmin ? storeId : user.storeId, products, {
          fileName,
          totalRows,
          totalColumns,
          uploadedBy:     user._id,
          uploadedByName: user.name ?? context.user.email ?? 'Unknown',
        });
      } catch (error) {
        logger.error(`bulkUpsertProducts error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Permission mutations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    requestPermission: async (_, { storeId, requestType, reason, requestedMaxDiscountPercent, requestedProductPerms }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF);
        const req = await requestPermission({ staffId: user._id, storeId, requestType, reason, requestedMaxDiscountPercent, requestedProductPerms });
        // Notify store admin (non-blocking)
        sendPermissionRequestNotification(storeId, { staffName: user.name || 'Staff', requestType }).catch(() => {});
        return req;
      } catch (error) {
        logger.error(`requestPermission error: ${error.message}`);
        throw error;
      }
    },

    approvePermissionRequest: async (_, { requestId, reviewNote, grantedMaxDiscountPercent, grantedProductPerms }, context) => {
      requireAuth(context);
      try {
        const admin = requireDbUser(context);
        requireRole(admin, Roles.ADMIN);
        const req = await approveRequest(requestId, { adminId: admin._id, reviewNote, grantedMaxDiscountPercent, grantedProductPerms });
        sendPermissionStatusNotification(req.staffId, { status: 'approved', requestType: req.requestType, reviewNote }).catch(() => {});
        return req;
      } catch (error) {
        logger.error(`approvePermissionRequest error: ${error.message}`);
        throw error;
      }
    },

    rejectPermissionRequest: async (_, { requestId, reviewNote }, context) => {
      requireAuth(context);
      try {
        const admin = requireDbUser(context);
        requireRole(admin, Roles.ADMIN);
        const req = await rejectRequest(requestId, { adminId: admin._id, reviewNote });
        sendPermissionStatusNotification(req.staffId, { status: 'rejected', requestType: req.requestType, reviewNote }).catch(() => {});
        return req;
      } catch (error) {
        logger.error(`rejectPermissionRequest error: ${error.message}`);
        throw error;
      }
    },

    revokeStaffPermission: async (_, { staffId, storeId, permissionType }, context) => {
      requireAuth(context);
      try {
        const admin = requireDbUser(context);
        requireRole(admin, Roles.ADMIN);
        const perm = await revokePermission(staffId, storeId, { permissionType, adminId: admin._id });
        sendPermissionStatusNotification(staffId, { status: 'revoked', requestType: permissionType, reviewNote: '' }).catch(() => {});
        return perm;
      } catch (error) {
        logger.error(`revokeStaffPermission error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ Discount mutations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    generateDiscountCode: async (_, { storeId, discountPercent }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.STAFF);
        return await generateDiscountCode({ staffId: user._id, staffName: user.name || 'Staff', storeId, discountPercent });
      } catch (error) {
        logger.error(`generateDiscountCode error: ${error.message}`);
        throw error;
      }
    },

    validateDiscountCode: async (_, { code, storeId, subtotal }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.CUSTOMER);
        return await validateDiscountCode({ code, storeId, subtotal });
      } catch (error) {
        logger.error(`validateDiscountCode error: ${error.message}`);
        throw error;
      }
    },

    // â”€â”€ End permission/discount mutations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    updateUserRole: async (_, { userId, role, storeId }, context) => {
      requireAuth(context);
      try {
        const caller = requireDbUser(context);
        requireRole(caller, Roles.ADMIN);
        // Ownership check: the target user must belong to the caller's store.
        // Without this, an admin at Store A can reassign roles for staff at
        // Store B by supplying a different userId â€” a privilege escalation vector.
        const User = require('./models/User');
        const target = await User.findById(userId);
        if (!target) {
          throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
        }
        if (!caller.storeId || target.storeId?.toString() !== caller.storeId.toString()) {
          throw new GraphQLError('Access denied: target user does not belong to your store', {
            extensions: { code: 'FORBIDDEN' },
          });
        }
        return await updateUserRole(userId, role, storeId);
      } catch (error) {
        logger.error(`updateUserRole error: ${error.message}`);
        throw error;
      }
    },

    inviteStaff: async (_, { email, name, storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        await assertLimitNotReached(storeId, PLAN_LIMITS.MAX_STAFF);
        const Store = require('./models/Store');
        const store = await Store.findById(storeId);
        const result = await inviteStaff({ email, name, storeId, storeName: store?.name ?? 'Your Store' });
        refreshUsageCounters(storeId).catch(() => {});
        return result;
      } catch (error) {
        logger.error(`inviteStaff error: ${error.message}`);
        throw error;
      }
    },

    bulkInviteStaff: async (_, { invites, storeId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        const Store = require('./models/Store');
        const store = await Store.findById(storeId);
        return await bulkInviteStaff({ invites, storeId, storeName: store?.name ?? 'Your Store' });
      } catch (error) {
        logger.error(`bulkInviteStaff error: ${error.message}`);
        throw error;
      }
    },

    cancelInvite: async (_, { inviteId }, context) => {
      requireAuth(context);
      try {
        const user = requireDbUser(context);
        requireRole(user, Roles.ADMIN);
        return await cancelInvite(inviteId);
      } catch (error) {
        logger.error(`cancelInvite error: ${error.message}`);
        throw error;
      }
    },

    removeStaff: async (_, { userId }, context) => {
      requireAuth(context);
      try {
        const caller = requireDbUser(context);
        requireRole(caller, Roles.ADMIN);
        // Ownership check: the target staff member must belong to the caller's
        // store. Without this, an admin at Store A can fire staff from Store B.
        const User = require('./models/User');
        const target = await User.findById(userId);
        if (!target) {
          throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
        }
        if (!caller.storeId || target.storeId?.toString() !== caller.storeId.toString()) {
          throw new GraphQLError('Access denied: target user does not belong to your store', {
            extensions: { code: 'FORBIDDEN' },
          });
        }
        return await removeStaff(userId);
      } catch (error) {
        logger.error(`removeStaff error: ${error.message}`);
        throw error;
      }
    },
  },

  // â”€â”€ Field resolvers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  Order: {
    id: (order) => order._id.toString(),
    createdAt: (order) => order.createdAt.toISOString(),
    completedAt: (order) => order.completedAt?.toISOString() ?? null,
    cancelledAt: (order) => order.cancelledAt?.toISOString() ?? null,
    storeName: (order) => order._storeName ?? null,
    storeCode: (order) => order._storeCode ?? null,
    staffActions: (order) =>
      (order.staffActions ?? []).map((a) => ({
        ...a.toObject(),
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
    roles: (user) => user.roles ?? [Roles.CUSTOMER],
    role: (user) => {
      const roles = user.roles ?? [Roles.CUSTOMER];
      if (roles.includes(Roles.ADMIN)) return Roles.ADMIN;
      if (roles.includes(Roles.STAFF)) return Roles.STAFF;
      return Roles.CUSTOMER;
    },
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

  // â”€â”€ Subscription resolvers (field-level) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  StoreSubscription: {
    id:   (sub) => sub._id.toString(),
    plan: (sub) => sub.planId,    // populated by getStoreSubscription()
    usageCounters: (sub) => sub.usageCounters ?? {
      staffCount: 0, ordersThisMonth: 0, storeCount: 1, lastCountedAt: null,
    },
    currentPeriodStart: (sub) => sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd:   (sub) => sub.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt:        (sub) => sub.trialEndsAt?.toISOString() ?? null,
    gracePeriodEndsAt:  (sub) => sub.gracePeriodEndsAt?.toISOString() ?? null,
    nextBillingAt:      (sub) => sub.nextBillingAt?.toISOString() ?? null,
    cancelledAt:        (sub) => sub.cancelledAt?.toISOString() ?? null,
    overrideExpiresAt:  (sub) => sub.overrideExpiresAt?.toISOString() ?? null,
    billingCycle:       (sub) => sub.billingCycle ?? 'none',
    autoRenew:          (sub) => sub.autoRenew ?? true,
    isAdminOverride:    (sub) => sub.isAdminOverride ?? false,
  },

  SubscriptionPlan: {
    id:          (plan) => plan._id.toString(),
    description: (plan) => plan.description ?? '',
    trialDays:   (plan) => plan.trialDays ?? 0,
    graceDays:   (plan) => plan.graceDays ?? 7,
    isRecommended: (plan) => plan.isRecommended ?? false,
    displayOrder:  (plan) => plan.displayOrder ?? 99,
  },
};

// â”€â”€ Subscription queries & mutations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Injected separately to keep the resolver map readable.

resolvers.Query.availablePlans = async () => {
  try {
    return await getAvailablePlans();
  } catch (err) {
    logger.error(`availablePlans error: ${err.message}`);
    throw err;
  }
};

resolvers.Query.storeSubscription = async (_, { storeId }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    return await getStoreSubscription(storeId);
  } catch (err) {
    logger.error(`storeSubscription error: ${err.message}`);
    throw err;
  }
};

resolvers.Query.featureAccessMap = async (_, { storeId }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    return await getFeatureAccessMap(storeId);
  } catch (err) {
    logger.error(`featureAccessMap error: ${err.message}`);
    throw err;
  }
};

resolvers.Query.planUsage = async (_, { storeId, limitKey }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    const result = await getRemainingUsage(storeId, limitKey);
    return { limitKey, ...result };
  } catch (err) {
    logger.error(`planUsage error: ${err.message}`);
    throw err;
  }
};

resolvers.Mutation.cancelSubscription = async (_, { storeId, cancelReason }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    return await cancelSubscription(storeId, {
      cancelReason,
      triggeredBy:     context.user.uid,
      triggeredByRole: Roles.ADMIN,
    });
  } catch (err) {
    logger.error(`cancelSubscription error: ${err.message}`);
    throw err;
  }
};

resolvers.Mutation.setAdminSubscriptionOverride = async (_, { storeId, planName, days, overrideReason }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    return await setAdminOverride(storeId, {
      planName,
      days,
      overrideReason,
      triggeredBy:     context.user.uid,
      triggeredByRole: Roles.ADMIN,
    });
  } catch (err) {
    logger.error(`setAdminSubscriptionOverride error: ${err.message}`);
    throw err;
  }
};

resolvers.Mutation.createSubscriptionOrder = async (_, { storeId, planName, billingCycle }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    const plans = await getAvailablePlans();
    const plan = plans.find(p => p.name === planName);
    if (!plan) {
      throw new GraphQLError(`Plan '${planName}' not found or not available`, { extensions: { code: 'NOT_FOUND' } });
    }
    const amount = billingCycle === 'annual' ? plan.price.annual : plan.price.monthly;
    if (!amount || amount <= 0) {
      throw new GraphQLError('Invalid plan amount', { extensions: { code: 'BAD_REQUEST' } });
    }
    return await createRazorpayOrder(amount);
  } catch (err) {
    logger.error(`createSubscriptionOrder error: ${err.message}`);
    throw err;
  }
};

resolvers.Mutation.confirmSubscriptionPayment = async (_, { storeId, planName, billingCycle, razorpayOrderId, razorpayPaymentId, razorpaySignature }, context) => {
  requireAuth(context);
  try {
    const user = requireDbUser(context);
    requireRole(user, Roles.ADMIN);
    const isValid = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) {
      throw new GraphQLError('Payment verification failed â€” signature mismatch', { extensions: { code: 'PAYMENT_VERIFICATION_FAILED' } });
    }
    return await activatePlan(storeId, {
      planName,
      billingCycle: billingCycle === 'annual' ? 'annual' : 'monthly',
      paymentId:       razorpayPaymentId,
      triggeredBy:     context.user.uid,
      triggeredByRole: Roles.ADMIN,
    });
  } catch (err) {
    logger.error(`confirmSubscriptionPayment error: ${err.message}`);
    throw err;
  }
};

// â”€â”€ Helper: serialize PermissionRequest for GraphQL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _formatRequest(r) {
  return {
    ...r,
    id:          r._id.toString(),
    staffId:     r.staffId?.toString(),
    storeId:     r.storeId?.toString(),
    reviewedBy:  r.reviewedBy?.toString() || null,
    reviewedAt:  r.reviewedAt?.toISOString()  || null,
    createdAt:   r.createdAt?.toISOString()   || '',
  };
}

module.exports = resolvers;

