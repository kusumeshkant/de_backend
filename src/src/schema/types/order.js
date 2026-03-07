const { gql } = require('apollo-server');

const orderType = gql`
  type Order {
    id: ID!
    user: User!
    products: [Product!]!
    total: Float!
    createdAt: String!
  }

  extend type Query {
    orders: [Order!]!
  }

  extend type Mutation {
    createOrder(products: [ID!]!): Order!
  }
`;

module.exports = orderType;