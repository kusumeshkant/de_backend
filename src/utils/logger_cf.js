/**
 * Lightweight logger for Cloudflare Workers.
 * Outputs to CF Workers logs (visible via `wrangler tail`).
 * Drop-in compatible with the winston logger interface used across the project.
 */

const logger = {
  info: (msg) => console.log(`[INFO]: ${msg}`),
  warn: (msg) => console.warn(`[WARN]: ${msg}`),
  error: (msg) => console.error(`[ERROR]: ${msg}`),
  debug: (msg) => console.debug(`[DEBUG]: ${msg}`),
};

module.exports = logger;
