const typeDefs = `#graphql
  type Product {
    id: ID!
    barcode: String!
    name: String!
    description: String
    price: Float!
    imageUrl: String
    storeId: ID
  }

  type Store {
    id: ID!
    name: String!
    address: String
    imageUrl: String
    latitude: Float
    longitude: Float
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

  type Query {
    # Used by scanner — look up a product by barcode
    productByBarcode(barcode: String!): Product

    # Used by dashboard — list all stores
    stores: [Store!]!

    # Get a single store
    store(id: ID!): Store

    # Order history (requires Firebase auth)
    myOrders: [Order!]!

    # Single order detail (requires Firebase auth)
    order(id: ID!): Order
  }

  type Mutation {
    # Submit cart as an order (requires Firebase auth)
    createOrder(
      storeId: ID!
      items: [OrderItemInput!]!
      total: Float!
      tax: Float!
      grandTotal: Float!
    ): Order!
  }
`;

module.exports = typeDefs;
