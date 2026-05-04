/**
 * validateSchema — dev-time GraphQL consistency checker.
 *
 * Call once at server startup (before Apollo starts) to surface any
 * schema/resolver mismatch as a clear log rather than a cryptic Apollo crash.
 *
 * Usage (src/index.js or wherever Apollo is initialised):
 *   if (process.env.NODE_ENV !== 'production') require('./utils/validate_schema')();
 */

const { buildSchema } = require('graphql');

module.exports = function validateSchema() {
  let typeDefs, resolvers;
  try {
    typeDefs  = require('../schema/typeDefs.js');
    resolvers = require('../resolvers.js');
  } catch (e) {
    console.warn('[schema-validator] Could not load schema/resolvers:', e.message);
    return;
  }

  let schema;
  try {
    schema = buildSchema(typeDefs);
  } catch (e) {
    console.error('[schema-validator] typeDefs PARSE ERROR:', e.message);
    return;
  }

  const schemaQuery    = Object.keys(schema.getQueryType()?.getFields()    ?? {});
  const schemaMutation = Object.keys(schema.getMutationType()?.getFields() ?? {});
  const resolverQuery    = Object.keys(resolvers.Query    ?? {});
  const resolverMutation = Object.keys(resolvers.Mutation ?? {});

  const issues = [];

  const missingQ = schemaQuery.filter(f => !resolverQuery.includes(f));
  const extraQ   = resolverQuery.filter(f => !schemaQuery.includes(f));
  const missingM = schemaMutation.filter(f => !resolverMutation.includes(f));
  const extraM   = resolverMutation.filter(f => !schemaMutation.includes(f));

  if (missingQ.length) issues.push(`Query fields in schema but NO resolver: ${missingQ.join(', ')}`);
  if (extraQ.length)   issues.push(`Query resolvers with NO schema field: ${extraQ.join(', ')}`);
  if (missingM.length) issues.push(`Mutation fields in schema but NO resolver: ${missingM.join(', ')}`);
  if (extraM.length)   issues.push(`Mutation resolvers with NO schema field: ${extraM.join(', ')}`);

  if (issues.length === 0) {
    console.log(`[schema-validator] OK — ${schemaQuery.length} Query + ${schemaMutation.length} Mutation fields, all consistent.`);
  } else {
    console.error('[schema-validator] MISMATCH DETECTED — Apollo will crash on startup:');
    issues.forEach(i => console.error('  ✗', i));
  }
};
