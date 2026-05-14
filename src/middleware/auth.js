const admin = require('firebase-admin');
const logger = require('../utils/logger_cf');

// ── Firebase Admin initialisation ─────────────────────────────────────────────
// Runs once at module load time. Never call initializeApp() elsewhere.
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Production / Render / Azure: JSON string in env var.
      // The value must be a single-line minified JSON string — actual newlines
      // in the private_key field must be the two-character sequence \n, not
      // real line breaks, or JSON.parse will throw.
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      // Local development: GOOGLE_APPLICATION_CREDENTIALS file path in env
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  } catch (err) {
    // Log to stderr immediately — this runs before the Winston logger is loaded.
    // A crash here produces no output without this guard, making it impossible
    // to diagnose from Render/Azure logs.
    console.error('[auth] Firebase Admin init failed:', err.message);
    console.error('[auth] Hint: FIREBASE_SERVICE_ACCOUNT must be a valid single-line JSON string.');
    console.error('[auth] Common cause: newlines in private_key were not escaped as \\n.');
    process.exit(1);
  }
}

// ── Error code classification ─────────────────────────────────────────────────
// Maps Firebase Admin SDK error codes to human-readable categories.
// Used only for logging — clients always receive UNAUTHENTICATED, never error details.
const FIREBASE_ERROR_TYPE = {
  'auth/id-token-expired':         'TOKEN_EXPIRED',
  'auth/id-token-revoked':         'TOKEN_REVOKED',
  'auth/user-disabled':            'USER_DISABLED',
  'auth/argument-error':           'TOKEN_MALFORMED',
  'auth/invalid-id-token':         'TOKEN_MALFORMED',
  'auth/network-request-failed':   'FIREBASE_NETWORK_ERROR',
  'auth/internal-error':           'FIREBASE_INTERNAL_ERROR',
};

/**
 * Extracts and verifies the Firebase JWT from the Authorization header.
 *
 * Returns a FirebaseUser object on success, null on any failure.
 * Null means the request is unauthenticated — resolvers that require auth
 * will throw UNAUTHENTICATED via requireAuth(). Public resolvers proceed.
 *
 * Verification includes revocation check (checkRevoked = true) so that
 * manually revoked tokens (e.g. when a staff member is removed) are rejected
 * within one request cycle instead of waiting up to 1 hour for expiry.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{uid: string, email: string|null, phone: string|null}|null>}
 */
async function verifyToken(req) {
  const authHeader = req.headers['authorization'] || '';

  // No header or wrong scheme — unauthenticated request, not an error
  if (!authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.split('Bearer ')[1];
  if (!token) return null;

  try {
    // checkRevoked=true: rejects tokens manually revoked via Firebase Console
    // or Admin SDK revokeRefreshTokens(). Slight latency cost (~1 extra lookup)
    // only applies when the token is actually revoked.
    const decoded = await admin.auth().verifyIdToken(token, /* checkRevoked= */ true);

    return {
      uid:   decoded.uid,
      email: decoded.email         || null,
      phone: decoded.phone_number  || null,
    };

  } catch (err) {
    const errorType = FIREBASE_ERROR_TYPE[err.code] || 'UNKNOWN';

    if (errorType === 'TOKEN_EXPIRED') {
      // Expected: Firebase client SDK refreshes tokens every ~55 min.
      // The client-side ErrorLink will force-refresh and retry automatically.
      // Log at debug so this doesn't create noise in production logs.
      logger.debug(`[auth] Expired token rejected (client will refresh and retry)`);

    } else if (errorType === 'FIREBASE_NETWORK_ERROR') {
      // Firebase Admin couldn't reach googleapis.com — transient infra issue.
      // The client will retry; log at warn because it may indicate a deployment
      // problem or network misconfiguration in Cloudflare Workers.
      logger.warn(`[auth] Firebase network error during token verification — ${err.message}`);

    } else if (errorType === 'TOKEN_REVOKED') {
      // Token was explicitly revoked (e.g. staff member removed from store).
      // The client will hit session expiry and redirect to login. Log at info
      // so you have an audit trail without exposing uid in error responses.
      logger.info(`[auth] Revoked token rejected [${errorType}]`);

    } else if (errorType === 'USER_DISABLED') {
      logger.info(`[auth] Disabled Firebase account rejected`);

    } else {
      // Malformed token, internal Firebase error, or anything unexpected.
      // Log at warn — these should not appear in normal operation.
      logger.warn(`[auth] Token verification failed [${errorType} / ${err.code}]: ${err.message}`);
    }

    // Always return null — callers never see internal error details
    return null;
  }
}

module.exports = { verifyToken };
