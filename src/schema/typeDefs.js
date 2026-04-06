const typeDefs = `#graphql
  type ProductCategory {
    main: String
    sub: String
  }

  type ProductSize {
    garment: String
    actual: String
  }

  type Product {
    id: ID!
    barcode: String!
    sku: String
    storeId: ID
    name: String!
    description: String
    brand: String
    gender: String
    color: String
    imageUrl: String
    category: ProductCategory
    size: ProductSize
    mrp: Float!
    price: Float!
    stock: Int!
    reorderLevel: Int
    isAvailable: Boolean
  }

  type Store {
    id: ID!
    storeCode: String
    name: String!
    address: String
    imageUrl: String
    latitude: Float
    longitude: Float
    isActive: Boolean
    distanceKm: Float
  }

  type OrderItem {
    barcode: String!
    name: String!
    mrp: Float
    price: Float!
    quantity: Int!
    sku: String
    description: String
  }

  type StaffAction {
    staffId: String
    staffName: String
    action: String
    timestamp: String
    note: String
  }

  type FlaggedIssue {
    reason: String!
    note: String
    staffId: String
    staffName: String
    timestamp: String!
  }

  type Order {
    id: ID!
    storeId: ID
    storeName: String
    storeCode: String
    total: Float!
    tax: Float!
    grandTotal: Float!
    status: String!
    paymentStatus: String!
    createdAt: String!
    items: [OrderItem!]!
    staffActions: [StaffAction!]!
    flaggedIssue: FlaggedIssue
    completedAt: String
    cancelledAt: String
  }

  input OrderItemInput {
    barcode: String!
    name: String!
    mrp: Float
    price: Float!
    quantity: Int!
    sku: String
    description: String
  }

  type User {
    id: ID!
    phone: String
    name: String
    email: String
    role: String
    roles: [String!]!
    storeId: ID
  }

  type StaffInvite {
    id: ID!
    email: String!
    name: String!
    storeId: ID!
    storeName: String
    token: String!
    expiresAt: String!
    used: Boolean!
  }

  input StaffInviteInput {
    email: String!
    name: String!
  }

  type Query {
    # Used by scanner — look up a product by barcode within a specific store's inventory
    productByBarcode(barcode: String!, storeId: ID!): Product

    # Used by dashboard — list all stores
    stores: [Store!]!

    # Returns onboarded stores sorted by distance from user's location
    nearbyStores(lat: Float!, lon: Float!): [Store!]!

    # Get a single store
    store(id: ID!): Store

    # Current user profile (requires Firebase auth)
    me: User

    # Order history (requires Firebase auth)
    myOrders: [Order!]!

    # Single order detail (requires Firebase auth)
    order(id: ID!): Order

    # All orders for a store — used by dq_staff (requires Firebase auth)
    storeOrders(storeId: ID!): [Order!]!

    # Look up any order by ID — used by dq_staff QR scan / search (requires Firebase auth)
    orderById(orderId: ID!): Order

    # Admin: all orders across stores, optional filters (requires Firebase auth)
    allOrders(storeId: ID, status: String): [Order!]!

    # Admin: global dashboard stats (requires Firebase auth)
    dashboardStats: DashboardStats!

    # Admin: per-store analytics (requires Firebase auth)
    storeStats(storeId: ID!): StoreStats!

    # Admin: all staff and admin users (requires Firebase auth)
    allStaff: [User!]!

    # Admin: staff members for a specific store (requires Firebase auth)
    storeStaff(storeId: ID!): [User!]!

    # Admin: pending (unused, non-expired) invites for a store (requires Firebase auth)
    pendingInvites(storeId: ID!): [StaffInvite!]!

    # dq_staff: validate an invite code before accepting (requires Firebase auth)
    validateInviteToken(token: String!): StaffInvite!

    # Admin: look up any user by email — used to find and promote a newly registered staff (requires Firebase auth)
    userByEmail(email: String!): User

    # Admin: all products for a store (requires Firebase auth)
    storeProducts(storeId: ID!): [Product!]!

    # Check stock availability before payment — returns names of out-of-stock items (requires Firebase auth)
    validateCartStock(storeId: ID!, items: [OrderItemInput!]!): [String!]!
    uploadLogs(storeId: ID!): [UploadLog!]!

    # Store-level analytics — top products, daily revenue, KPIs (requires Firebase auth)
    storeAnalytics(storeId: ID): StoreAnalytics!

    # Customer retention — returning customers, retention rate, new vs repeat (requires Firebase auth)
    customerRetention(storeId: ID): CustomerRetentionStats!

    # Staff performance — orders completed, cancellations, flags, avg fulfillment time per staff member
    staffPerformance(storeId: ID): [StaffPerformanceStat!]!

    # Basket abandonment — cart checks that never converted to an order (requires Firebase auth)
    basketAbandonment(storeId: ID): BasketAbandonmentStats!

    # Customer LTV projection — avg spend, order frequency, active lifespan, top 10 customers (requires Firebase auth)
    customerLTV(storeId: ID): CustomerLTVStats!
  }

  type RazorpayOrder {
    id: String!
    amount: Int!
    currency: String!
  }

  # ── Bulk Upload ──────────────────────────────────────────────────────────────

  input BulkProductInput {
    barcode:      String!
    sku:          String
    name:         String!
    brand:        String
    gender:       String
    color:        String
    categoryMain: String
    categorySub:  String
    sizeGarment:  String
    sizeActual:   String
    mrp:          Float
    price:        Float!
    stock:        Int!
  }

  type BulkProductError {
    barcode: String!
    message: String!
  }

  type BulkUpsertResult {
    created:  Int!
    updated:  Int!
    skipped:  Int!
    errors:   [BulkProductError!]!
  }

  type UploadLog {
    id:             ID!
    storeId:        ID!
    storeName:      String
    uploadedBy:     ID
    uploadedByName: String!
    fileName:       String!
    uploadedAt:     String!
    totalRows:      Int!
    totalColumns:   Int!
    created:        Int!
    updated:        Int!
    skipped:        Int!
    errorCount:     Int!
    errors:         [BulkProductError!]!
  }

  type Mutation {
    # Admin self-registration — adds 'admin' to roles on first signup via dq_admin app
    registerAdmin: User!

    # Upgrade existing user to admin and link their store (called after store creation)
    upgradeToAdmin(storeId: ID!): User!

    # DQ App login — silently ensures 'customer' role exists on account
    ensureCustomerRole: Boolean!

    # Update user profile fields — name, phone, email (requires Firebase auth)
    updateProfile(name: String, phone: String, email: String): User!

    # Register/refresh FCM token for push notifications (requires Firebase auth)
    updateFcmToken(token: String!): Boolean!

    # Step 1: Create Razorpay order to initiate payment (requires Firebase auth)
    createRazorpayOrder(amount: Float!): RazorpayOrder!

    # Step 2: Verify payment and save order in DB (requires Firebase auth)
    createOrder(
      storeId: ID!
      items: [OrderItemInput!]!
      total: Float!
      tax: Float!
      grandTotal: Float!
      razorpayOrderId: String!
      razorpayPaymentId: String!
      razorpaySignature: String!
    ): Order!

    # Update order status — called by dq_staff (requires Firebase auth)
    # Valid statuses: pending → preparing → ready → completed | cancelled
    updateOrderStatus(orderId: ID!, status: String!): Order!

    # Flag an issue on an order — called by dq_staff (requires Firebase auth)
    # reasons: wrong_items | payment_mismatch | customer_absent | other
    flagOrderIssue(orderId: ID!, reason: String!, note: String): Order!

    # Admin: store CRUD (requires Firebase auth)
    createStore(name: String!, address: String!, lat: Float!, lon: Float!, storeCode: String): Store!
    updateStore(id: ID!, name: String, address: String, lat: Float, lon: Float, storeCode: String, isActive: Boolean): Store!
    deleteStore(id: ID!): Boolean!

    # Admin: product CRUD (requires Firebase auth)
    createProduct(
      storeId: ID!
      barcode: String!
      sku: String
      name: String!
      description: String
      brand: String
      gender: String
      color: String
      categoryMain: String
      categorySub: String
      sizeGarment: String
      sizeActual: String
      mrp: Float
      price: Float!
      stock: Int!
      reorderLevel: Int
    ): Product!
    updateProduct(
      id: ID!
      sku: String
      name: String
      description: String
      brand: String
      gender: String
      color: String
      categoryMain: String
      categorySub: String
      sizeGarment: String
      sizeActual: String
      mrp: Float
      price: Float
      stock: Int
      reorderLevel: Int
      isAvailable: Boolean
    ): Product!
    deleteProduct(id: ID!): Boolean!

    # Admin: bulk upsert products from Excel upload (requires Firebase auth)
    # Upserts by barcode within the store — creates new or updates existing
    bulkUpsertProducts(storeId: ID!, products: [BulkProductInput!]!, fileName: String, totalRows: Int, totalColumns: Int): BulkUpsertResult!

    # Admin: set user role and optional storeId (requires Firebase auth)
    updateUserRole(userId: ID!, role: String!, storeId: ID): User!

    # Admin: invite a staff member by email — sends invite email with code (requires Firebase auth)
    inviteStaff(email: String!, name: String!, storeId: ID!): StaffInvite!

    # Admin: bulk invite staff from Excel upload (requires Firebase auth)
    bulkInviteStaff(invites: [StaffInviteInput!]!, storeId: ID!): [StaffInvite!]!

    # Admin: cancel a pending invite (requires Firebase auth)
    cancelInvite(inviteId: ID!): Boolean!

    # Admin: remove staff from store — resets role to customer (requires Firebase auth)
    removeStaff(userId: ID!): Boolean!

    # dq_staff: accept an invite code — links staff to store (requires Firebase auth)
    acceptInvite(token: String!): User!
  }

  type ProductStat {
    name: String!
    barcode: String!
    totalSold: Int!
    revenue: Float!
  }

  type DailyRevenueStat {
    date: String!
    revenue: Float!
    orders: Int!
  }

  type DiscountedProduct {
    name: String!
    barcode: String!
    avgDiscount: Float!
    totalSold: Int!
  }

  type HourStat {
    hour: Int!
    orders: Int!
    revenue: Float!
  }

  type DayStat {
    day: String!
    dayIndex: Int!
    orders: Int!
    revenue: Float!
  }

  type StoreAnalytics {
    totalRevenue: Float!
    totalOrders: Int!
    completedOrders: Int!
    cancelledOrders: Int!
    avgOrderValue: Float!
    avgItemsPerOrder: Float!
    totalUnitsSold: Int!
    thisWeekRevenue: Float!
    lastWeekRevenue: Float!
    lowStockCount: Int!
    topProducts: [ProductStat!]!
    dailyRevenue: [DailyRevenueStat!]!
    avgFulfillmentTime: Float
    avgFulfillmentTimeToday: Float
    peakHours: [HourStat!]!
    peakDays: [DayStat!]!
    avgDiscountDepth: Float
    topDiscountedProducts: [DiscountedProduct!]!
  }

  type BasketAbandonmentStats {
    totalChecks: Int!
    convertedChecks: Int!
    abandonedChecks: Int!
    abandonmentRate: Float!
    conversionRate: Float!
    thisWeekAbandonmentRate: Float!
    lastWeekAbandonmentRate: Float!
  }

  type StaffPerformanceStat {
    staffId: String!
    staffName: String!
    ordersCompleted: Int!
    ordersCancelled: Int!
    flagsRaised: Int!
    totalOrdersHandled: Int!
    avgFulfillmentTime: Float
    cancellationRate: Float!
  }

  type CustomerRetentionStats {
    totalCustomers: Int!
    returningCustomers: Int!
    retentionRate: Float!
    avgRepeatIntervalDays: Float
    newCustomersThisWeek: Int!
    newCustomersLastWeek: Int!
  }

  type TopCustomerStat {
    userId: String!
    name: String!
    phone: String
    totalSpend: Float!
    totalOrders: Int!
  }

  type CustomerLTVStats {
    totalCustomers: Int!
    avgRevenuePerCustomer: Float!
    avgOrdersPerCustomer: Float!
    avgDaysActive: Float
    projectedMonthlyLTV: Float
    topCustomers: [TopCustomerStat!]!
  }

  type StoreRevenue {
    store: Store
    revenue: Float!
    orderCount: Int!
  }

  type DashboardStats {
    totalRevenue: Float!
    totalOrders: Int!
    pendingOrders: Int!
    completedOrders: Int!
    activeStores: Int!
    topStores: [StoreRevenue!]!
    recentOrders: [Order!]!
    thisWeekOrders: Int!
    lastWeekOrders: Int!
    orderGrowthRate: Float
    thisWeekRevenue: Float!
    lastWeekRevenue: Float!
    revenueGrowthRate: Float
  }

  type StoreStats {
    store: Store
    totalRevenue: Float!
    totalOrders: Int!
    pendingOrders: Int!
    completedOrders: Int!
    recentOrders: [Order!]!
  }
`;

module.exports = typeDefs;
