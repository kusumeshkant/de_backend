const { createTestClient } = require('apollo-server-testing');
const { ApolloServer } = require('apollo-server');
const typeDefs = require('../src/schema/typeDefs');
const resolvers = require('../src/resolvers');
const Product = require('../src/models/Product');

jest.mock('../src/models/Product');

const server = new ApolloServer({
  typeDefs,
  resolvers,
});

const { query, mutate } = createTestClient(server);

describe('Product API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should add a new product', async () => {
    const ADD_PRODUCT = `
      mutation AddProduct($name: String!, $description: String!, $price: Float!, $stock: Int!) {
        addProduct(name: $name, description: $description, price: $price, stock: $stock) {
          id
          name
          description
          price
          stock
        }
      }
    `;

    Product.mockImplementation(() => ({
      save: jest.fn().mockResolvedValue({
        id: '1',
        name: 'Test Product',
        description: 'A product for testing',
        price: 99.99,
        stock: 10,
      }),
    }));

    const res = await mutate({
      mutation: ADD_PRODUCT,
      variables: {
        name: 'Test Product',
        description: 'A product for testing',
        price: 99.99,
        stock: 10,
      },
    });

    expect(res.data.addProduct.name).toBe('Test Product');
    expect(res.data.addProduct.price).toBe(99.99);
  });

  it('should fetch all products', async () => {
    const GET_PRODUCTS = `
      query {
        products {
          id
          name
          description
          price
          stock
        }
      }
    `;

    Product.find.mockResolvedValue([
      {
        id: '1',
        name: 'Test Product',
        description: 'A product for testing',
        price: 99.99,
        stock: 10,
      },
    ]);

    const res = await query({ query: GET_PRODUCTS });

    expect(res.data.products.length).toBeGreaterThan(0);
    expect(res.data.products[0].name).toBe('Test Product');
  });
});