const { createTestClient } = require('apollo-server-testing');
const { ApolloServer } = require('apollo-server');
const typeDefs = require('../src/schema/typeDefs');
const resolvers = require('../src/resolvers');
const mongoose = require('mongoose');
const User = require('../src/models/User');

const server = new ApolloServer({
  typeDefs,
  resolvers,
});

const { query, mutate } = createTestClient(server);

describe('User API', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/test', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    await User.deleteMany();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  it('should register a new user', async () => {
    const REGISTER = `
      mutation Register($name: String!, $email: String!, $password: String!) {
        register(name: $name, email: $email, password: $password) {
          id
          name
          email
        }
      }
    `;

    const res = await mutate({
      mutation: REGISTER,
      variables: {
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      },
    });

    expect(res.data.register.name).toBe('Test User');
    expect(res.data.register.email).toBe('test@example.com');
  });

  it('should login a user', async () => {
    const LOGIN = `
      mutation Login($email: String!, $password: String!) {
        login(email: $email, password: $password)
      }
    `;

    const res = await mutate({
      mutation: LOGIN,
      variables: {
        email: 'test@example.com',
        password: 'password123',
      },
    });

    expect(res.data.login).toBeTruthy();
  });
});