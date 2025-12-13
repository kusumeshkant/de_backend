const { gql } = require('apollo-server');

const userType = gql`
  type User {
    id: ID!
    name: String!
    email: String!
    password: String!
  }
`;

const productType = gql`
  type Product {
    id: ID!
    name: String!
    description: String!
    price: Float!
    stock: Int!
  }
`;

const orderType = gql`
  type Order {
    id: ID!
    user: User!
    products: [Product!]!
    total: Float!
    createdAt: String!
  }

  type Query {
    users: [User!]!
    products: [Product!]!
    orders: [Order!]!
  }

  type Mutation {
    register(name: String!, email: String!, password: String!): User!
    login(email: String!, password: String!): String!
    addProduct(name: String!, description: String!, price: Float!, stock: Int!): Product!
    createOrder(products: [ID!]!): Order!
  }
`;

module.exports = [userType, productType, orderType];