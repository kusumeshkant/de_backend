/**
 * Cloudflare Workers entry point for the DQ GraphQL API.
 *
 * Key differences from src/index.js (Railway/Node.js):
 *  - Uses @as-integrations/cloudflare-workers instead of startStandaloneServer
 *  - MongoDB connection is cached globally (no persistent process)
 *  - Firebase token verification uses custom JWKS verifier (no firebase-admin)
 *  - All secrets come from `env` (set via `wrangler secret put`)
 */

import { ApolloServer } from '@apollo/server';
import { startServerAndCreateCloudflareWorkersHandler } from '@as-integrations/cloudflare-workers';
import typeDefs from './src/schema/typeDefs.js';
import resolvers from './src/resolvers.js';
import { connectDB } from './src/db/connection.js';
import { verifyToken } from './src/middleware/auth_cf.js';
import { setEnv } from './src/services/notificationService_cf.js';
import { setRazorpayEnv } from './src/services/razorpayService.js';

let _handler = null;

async function getHandler(env) {
  // Build the Apollo handler once and cache it for the lifetime of the isolate
  if (_handler) return _handler;

  // Inject CF secrets into services that lazy-initialize from env
  setEnv(env);
  setRazorpayEnv(env);

  await connectDB(env.MONGO_URI);

  const server = new ApolloServer({ typeDefs, resolvers });

  _handler = startServerAndCreateCloudflareWorkersHandler(server, {
    context: async ({ request }) => {
      const user = await verifyToken(request, env.FIREBASE_PROJECT_ID);
      return { user };
    },
  });

  return _handler;
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    try {
      const handler = await getHandler(env);
      const response = await handler(request, env, ctx);

      // Attach CORS headers to every response
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (err) {
      console.error('[Worker] Unhandled error:', err.message);
      return new Response(JSON.stringify({ errors: [{ message: 'Internal server error' }] }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
