const typeDefs = `#graphql
  type Product {
    id: ID!
    barcode: String!
    name: String!
    description: String
    price: Float!
    imageUrl: String
    stock: Int!
    storeId: ID
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
    total: Float!
    tax: Float!
    grandTotal: Float!
    status: String!
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
  }

  type RazorpayOrder {
    id: String!
    amount: Int!
    currency: String!
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
    createProduct(storeId: ID!, barcode: String!, name: String!, description: String, price: Float!, stock: Int!): Product!
    updateProduct(id: ID!, name: String, description: String, price: Float, stock: Int): Product!
    deleteProduct(id: ID!): Boolean!

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
