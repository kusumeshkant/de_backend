const { GraphQLError } = require('graphql');
const { Roles, AppId, RoleHint, RoleGroups } = require('./constants/roles');
const { getOrCreateUser, getProfile, updateProfile, updateFcmToken, getAllStaff, updateUserRole, upgradeToAdmin, getUserByEmail, ensureCustomerRole } = require('./services/userService');
const { inviteStaff, bulkInviteStaff, validateInviteToken, acceptInvite, getStoreStaff, removeStaff, getPendingInvites, cancelInvite } = require('./services/inviteService');
const { sendOrderConfirmation, sendOrderStatusUpdate, sendNewOrderToStaff } = require('./services/notificationService_cf');
const { getProductByBarcode, getStoreProducts, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, getUploadLogs } = require('./services/productService');
const { getStores, getStoreById, getNearbyStores, createStore, updateStore, deleteStore } = require('./services/storeService');
const { createOrder, getMyOrders, getOrderById, getStoreOrders, getOrderByIdForStaff, updateOrderStatus, flagOrderIssue, getAllOrders, getDashboardStats, getStoreStats, validateCartStock, getStoreAnalytics, getCustomerRetention, getStaffPerformance, getBasketAbandonmentStats, getCustomerLTV, getMonthlyRevenue } = require('./services/orderService');
const { createRazorpayOrder, verifyPayment } = require('./services/razorpayService');
const logger = require('./utils/logger_cf');

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireAuth(context) {
  if (!context.user) {
    throw new GraphQLError('You must be logged in', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
}

/** Returns true if the DB user has ANY of the given roles. */
function hasRole(user, ...roles) {
  return roles.some(r => user.roles?.includes(r));
}

/**
 * Throws FORBIDDEN if the DB user does not have at least one of the given roles.
 * Use after getOrCreateUser / findUser to enforce per-resolver access control.
 */
function requireRole(user, ...roles) {
  if (!hasRole(user, ...roles)) {
    const roleStr = roles.join(' or ');
    logger.warn(`RBAC: uid=${user.firebase_uid} roles=${user.roles} tried operation requiring ${roleStr}`);
    throw new GraphQLError(`This operation requires ${roleStr} access`, {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

const resolvers = {
  Query: {

    // ── Public ───────────────────────────────────────────────────────────────

    productByBarcode: async (_, { barcode, storeId }) => {
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

    // ── Any authenticated role ────────────────────────────────────────────────

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

    /**
     * App-specific login gate — must be called once on login and cold start.
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
            // Existing user — allow if they hold the customer role.
            // A dual-role account (customer + staff, or customer + admin) IS
            // allowed — the customer role is what matters here, not whether
            // they also have another role.
            if (!hasRole(user, Roles.CUSTOMER)) {
              if (hasRole(user, Roles.ADMIN)) {
                throw new GraphQLError(
                  'This account is registered as a store admin. To shop on DQ, open the Sign Up screen and tap "Continue with Google" — it will add a customer profile to your account.',
                  { extensions: { code: 'FORBIDDEN', hint: RoleHint.ADMIN_NO_CUSTOMER } }
                );
              }
              if (hasRole(user, Roles.STAFF)) {
                throw new GraphQLError(
                  'This account is registered as a store staff member. To shop on DQ, open the Sign Up screen and tap "Continue with Google" — it will add a customer profile to your account.',
                  { extensions: { code: 'FORBIDDEN', hint: RoleHint.STAFF_NO_CUSTOMER } }
                );
              }
              // Has unrecognised roles, no customer — block generically
              throw new GraphQLError(
                'This account does not have customer access. Please sign up on the DQ App to shop.',
                { extensions: { code: 'FORBIDDEN', hint: RoleHint.NO_CUSTOMER } }
              );
            }
            // user has customer role — fall through to return profile
          } else {
            // First-ever login to DQ App — safe to auto-create as customer.
            user = await getOrCreateUser(context.user);
          }

        } else if (appId === AppId.STAFF) {
          // Staff must have registered through the invite flow first.
          user = await User.findOne({ firebase_uid: context.user.uid });
          if (!user) {
            throw new GraphQLError(
              'No staff account found. Please register and accept your store invite.',
              { extensions: { code: 'NOT_FOUND' } }
            );
          }
          if (!hasRole(user, Roles.STAFF, Roles.ADMIN)) {
            throw new GraphQLError(
              'Access denied. Contact your store admin to get staff access.',
              { extensions: { code: 'FORBIDDEN' } }
            );
          }

        } else if (appId === AppId.ADMIN) {
          // Admins must have registered through the dq_admin signup flow first.
          user = await User.findOne({ firebase_uid: context.user.uid });
          if (!user || !hasRole(user, Roles.ADMIN)) {
            throw new GraphQLError(
              'This account is not registered as a store admin. Please sign up via the DQ Admin app.',
              { extensions: { code: 'FORBIDDEN' } }
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

    // ── Staff + Admin ─────────────────────────────────────────────────────────

    stores: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.STAFF, Roles.ADMIN);
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

    storeOrders: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.STAFF, Roles.ADMIN);
        return await getStoreProducts(storeId);
      } catch (error) {
        logger.error(`storeProducts error: ${error.message}`);
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

    // ── Admin only ────────────────────────────────────────────────────────────

    allOrders: async (_, { storeId, status }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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

    // ── Customer only ─────────────────────────────────────────────────────────

    myOrders: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.CUSTOMER);
        return await getOrderById(id, user._id);
      } catch (error) {
        logger.error(`order error: ${error.message}`);
        throw error;
      }
    },
  },

  // ── Mutations ─────────────────────────────────────────────────────────────

  Mutation: {

    // ── Any authenticated user ────────────────────────────────────────────────

    /**
     * Called by the DQ App (customer app) signup flow when a staff or admin
     * Google account wants to also shop as a customer.
     *
     * Adds 'customer' to the roles array without touching existing roles.
     * Customer is the lowest-privilege role — no guard beyond authentication
     * is needed. Idempotent: safe to call even if already a customer.
     */
    registerAsCustomer: async (_, __, context) => {
      requireAuth(context);
      try {
        const user = await User.findOne({ firebase_uid: context.user.uid });
        if (!user) {
          // First-ever login — create as customer
          return await getOrCreateUser(context.user);
        }
        if (hasRole(user, Roles.CUSTOMER)) {
          // Already a customer — idempotent, return as-is
          return await getProfile(user._id);
        }
        // Add customer role without touching other roles
        await ensureCustomerRole(user._id);
        logger.info(`registerAsCustomer: uid=${context.user.uid} previous_roles=[${user.roles}] — customer role added`);
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
        const user = await getOrCreateUser(context.user);
        if (hasRole(user, Roles.ADMIN)) return user; // idempotent

        // Prevent existing customers from self-promoting.
        // A real customer will have placed orders; a new admin account won't.
        const Order = require('./models/Order');
        const orderCount = await Order.countDocuments({ userId: user._id });
        if (orderCount > 0) {
          throw new GraphQLError(
            'This account already exists as a customer account and cannot be registered as an admin.',
            { extensions: { code: 'FORBIDDEN' } }
          );
        }

        return await upgradeToAdmin(user._id, user.storeId);
      } catch (error) {
        logger.error(`registerAdmin error: ${error.message}`);
        throw error;
      }
    },

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

    // acceptInvite is called during staff registration — user may only have
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

    // ── Customer only ─────────────────────────────────────────────────────────

    createRazorpayOrder: async (_, { amount }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
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
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature, ...orderArgs } = args;

        const isValid = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);
        if (!isValid) {
          throw new GraphQLError('Payment verification failed', {
            extensions: { code: 'PAYMENT_VERIFICATION_FAILED' },
          });
        }

        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.CUSTOMER);

        const order = await createOrder({
          userId: user._id,
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature,
          ...orderArgs,
        });
        logger.info(`Order created: ${order._id}`);

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

        return order;
      } catch (error) {
        logger.error(`createOrder error: ${error.message}`);
        throw error;
      }
    },

    // ── Staff + Admin ─────────────────────────────────────────────────────────

    updateOrderStatus: async (_, { orderId, status }, context) => {
      requireAuth(context);
      try {
        const staffUser = await getOrCreateUser(context.user);
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
        const staffUser = await getOrCreateUser(context.user);
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

    // ── Admin only ────────────────────────────────────────────────────────────

    upgradeToAdmin: async (_, { storeId }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        return await createStore({ name, address, lat, lon, storeCode });
      } catch (error) {
        logger.error(`createStore error: ${error.message}`);
        throw error;
      }
    },

    updateStore: async (_, { id, name, address, lat, lon, storeCode, isActive }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        return await updateStore(id, { name, address, lat, lon, storeCode, isActive });
      } catch (error) {
        logger.error(`updateStore error: ${error.message}`);
        throw error;
      }
    },

    deleteStore: async (_, { id }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        return await createProduct({ storeId, barcode, sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel });
      } catch (error) {
        logger.error(`createProduct error: ${error.message}`);
        throw error;
      }
    },

    updateProduct: async (_, { id, sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel, isAvailable }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        return await updateProduct(id, { sku, name, description, brand, gender, color, categoryMain, categorySub, sizeGarment, sizeActual, mrp, price, stock, reorderLevel, isAvailable });
      } catch (error) {
        logger.error(`updateProduct error: ${error.message}`);
        throw error;
      }
    },

    deleteProduct: async (_, { id }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        return await deleteProduct(id);
      } catch (error) {
        logger.error(`deleteProduct error: ${error.message}`);
        throw error;
      }
    },

    bulkUpsertProducts: async (_, { storeId, products, fileName, totalRows, totalColumns }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        return await bulkUpsertProducts(storeId, products, {
          fileName,
          totalRows,
          totalColumns,
          uploadedBy: user._id,
          uploadedByName: user.name ?? context.user.email ?? 'Unknown',
        });
      } catch (error) {
        logger.error(`bulkUpsertProducts error: ${error.message}`);
        throw error;
      }
    },

    updateUserRole: async (_, { userId, role, storeId }, context) => {
      requireAuth(context);
      try {
        const caller = await getOrCreateUser(context.user);
        requireRole(caller, Roles.ADMIN);
        // Ownership check: the target user must belong to the caller's store.
        // Without this, an admin at Store A can reassign roles for staff at
        // Store B by supplying a different userId — a privilege escalation vector.
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
        const user = await getOrCreateUser(context.user);
        requireRole(user, Roles.ADMIN);
        const Store = require('./models/Store');
        const store = await Store.findById(storeId);
        return await inviteStaff({ email, name, storeId, storeName: store?.name ?? 'Your Store' });
      } catch (error) {
        logger.error(`inviteStaff error: ${error.message}`);
        throw error;
      }
    },

    bulkInviteStaff: async (_, { invites, storeId }, context) => {
      requireAuth(context);
      try {
        const user = await getOrCreateUser(context.user);
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
        const user = await getOrCreateUser(context.user);
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
        const caller = await getOrCreateUser(context.user);
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

  // ── Field resolvers ───────────────────────────────────────────────────────

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
};

module.exports = resolvers;
