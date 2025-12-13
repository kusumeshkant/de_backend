const { gql } = require('apollo-server');

const productType = gql`
  type Product {
    id: ID!
    name: String!
    description: String!
    price: Float!
    stock: Int!
  }

  extend type Query {
    products: [Product!]!
  }

  extend type Mutation {
    addProduct(name: String!, description: String!, price: Float!, stock: Int!): Product!
  }
`;

module.exports = productType;