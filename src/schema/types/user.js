const { gql } = require('apollo-server');

const userType = gql`
  type User {
    id: ID!
    name: String!
    email: String!
    password: String!
  }

  extend type Query {
    users: [User!]!
  }

  extend type Mutation {
    register(name: String!, email: String!, password: String!): User!
    login(email: String!, password: String!): String!
  }
`;

module.exports = userType;