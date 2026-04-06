const { createTestClient } = require('apollo-server-testing');
const { ApolloServer } = require('apollo-server');
const typeDefs = require('../src/schema/typeDefs');
const resolvers = require('../src/resolvers');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');

jest.mock('../src/models/Order');
jest.mock('../src/models/Product');

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: () => ({
    user: { id: 'placeholder-user-id' }, // Mock user context
  }),
});

const { query, mutate } = createTestClient(server);

describe('Order API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a new order', async () => {
    const CREATE_ORDER = `
      mutation CreateOrder($products: [ID!]!) {
        createOrder(products: $products) {
          id
          total
          products {
            name
          }
        }
      }
    `;

    Product.find.mockResolvedValue([
      {
        id: '1',
        name: 'Test Product',
        description: 'A product for testing',
        price: 50.0,
        stock: 20,
      },
    ]);

    Order.mockImplementation(() => ({
      save: jest.fn().mockResolvedValue({
        id: '1',
        total: 50.0,
        products: [
          {
            name: 'Test Product',
          },
        ],
      }),
    }));

    const res = await mutate({
      mutation: CREATE_ORDER,
      variables: {
        products: ['1'],
      },
    });

    expect(res.data.createOrder.total).toBe(50.0);
    expect(res.data.createOrder.products[0].name).toBe('Test Product');
  });

  it('should fetch all orders', async () => {
    const GET_ORDERS = `
      query {
        orders {
          id
          total
          products {
            name
          }
        }
      }
    `;

    Order.find.mockResolvedValue([
      {
        id: '1',
        total: 50.0,
        products: [
          {
            name: 'Test Product',
          },
        ],
      },
    ]);

    const res = await query({ query: GET_ORDERS });

    expect(res.data.orders.length).toBeGreaterThan(0);
    expect(res.data.orders[0].total).toBe(50.0);
  });
});