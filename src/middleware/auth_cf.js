/**
 * Firebase JWT verification for Cloudflare Workers.
 * firebase-admin SDK doesn't run in edge/worker runtime — this module
 * manually verifies the JWT against Google's public JWKS endpoint.
 */

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let _certsCache = null;
let _certsCacheExpiry = 0;

async function getGoogleCerts() {
  const now = Date.now();
  if (_certsCache && now < _certsCacheExpiry) return _certsCache;

  const res = await fetch(GOOGLE_CERTS_URL);
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;

  _certsCache = await res.json();
  _certsCacheExpiry = now + maxAge * 1000;
  return _certsCache;
}

function base64urlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return atob(padded);
}

function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT structure');
  const header = JSON.parse(base64urlDecode(parts[0]));
  const payload = JSON.parse(base64urlDecode(parts[1]));
  return { header, payload, signature: parts[2], raw: parts };
}

async function importPublicKey(pemCert) {
  // Strip PEM headers
  const pemBody = pemCert
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '');

  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'raw',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  ).catch(async () => {
    // DER is a certificate, not a raw key — import as SPKI via SubtleCrypto
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return key;
  });
}

async function verifyCertSignature(token, cert) {
  const parts = token.split('.');
  const headerPayload = `${parts[0]}.${parts[1]}`;
  const signatureB64 = parts[2];

  const encoder = new TextEncoder();
  const data = encoder.encode(headerPayload);
  const sigBytes = Uint8Array.from(base64urlDecode(signatureB64), c => c.charCodeAt(0));

  // Import the X.509 certificate PEM and extract the public key
  const pemBody = cert
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '');

  const certDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  // Use SubtleCrypto to import as X.509 certificate (spki format not directly, use importKey with 'pkix')
  // CF Workers supports importing public keys from SPKI but not directly from DER certs.
  // We use a workaround: use the Web Crypto API's RSASSA-PKCS1-v1_5
  const key = await crypto.subtle.importKey(
    'raw',
    certDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  ).catch(() =>
    // Fallback for DER-encoded cert: wrap in SPKI
    crypto.subtle.importKey(
      'spki',
      certDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
  );

  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, data);
}

/**
 * Verifies a Firebase ID token (JWT) in a CF Workers-compatible way.
 * Returns { uid, email, phone } on success, or null on failure.
 */
async function verifyFirebaseToken(token, projectId) {
  try {
    const { header, payload } = parseJwt(token);

    // Basic claim checks
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId) return null;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (!payload.sub || payload.sub === '') return null;
    if (payload.iat > now + 60) return null;    // not yet valid (1 min skew)
    if (payload.exp < now) return null;          // expired

    // Fetch Google's public certs and find the right one by kid
    const certs = await getGoogleCerts();
    const cert = certs[header.kid];
    if (!cert) return null;

    const valid = await verifyCertSignature(token, cert);
    if (!valid) return null;

    return {
      uid: payload.sub,
      email: payload.email || null,
      phone: payload.phone_number || null,
    };
  } catch {
    return null;
  }
}

/**
 * Drop-in context builder for Apollo Server in CF Workers.
 * Usage: const user = await verifyToken(request, env.FIREBASE_PROJECT_ID);
 */
async function verifyToken(request, projectId) {
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyFirebaseToken(token, projectId);
}

module.exports = { verifyToken };
