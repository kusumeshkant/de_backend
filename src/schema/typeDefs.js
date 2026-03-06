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
  }

  type RazorpayOrder {
    id: String!
    amount: Int!
    currency: String!
  }

  type Mutation {
    # Update user display name (requires Firebase auth)
    updateProfile(name: String!): User!

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

    # Update order status — called by store admin (requires Firebase auth)
    # Valid statuses: pending → preparing → ready → completed | cancelled
    updateOrderStatus(orderId: ID!, status: String!): Order!
  }
`;

module.exports = typeDefs;
