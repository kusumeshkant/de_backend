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
    distanceKm: Float
  }

  type OrderItem {
    barcode: String!
    name: String!
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
  }

  input OrderItemInput {
    barcode: String!
    name: String!
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
    storeId: ID
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

    # Admin: look up any user by email — used to find and promote a newly registered staff (requires Firebase auth)
    userByEmail(email: String!): User

    # Admin: all products for a store (requires Firebase auth)
    storeProducts(storeId: ID!): [Product!]!

    # Check stock availability before payment — returns names of out-of-stock items (requires Firebase auth)
    validateCartStock(storeId: ID!, items: [OrderItemInput!]!): [String!]!
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
    created: Int!
    updated: Int!
    errors:  [BulkProductError!]!
  }

  type Mutation {
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
    updateStore(id: ID!, name: String, address: String, lat: Float, lon: Float, storeCode: String): Store!
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
      mrp: Float!
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
    bulkUpsertProducts(storeId: ID!, products: [BulkProductInput!]!): BulkUpsertResult!

    # Admin: set user role and optional storeId (requires Firebase auth)
    updateUserRole(userId: ID!, role: String!, storeId: ID): User!
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
