const admin = require('firebase-admin');

// Initialize Firebase Admin once
if (!admin.apps.length) {
  // Production: FIREBASE_SERVICE_ACCOUNT env var contains the JSON string
  // Local: GOOGLE_APPLICATION_CREDENTIALS points to the JSON file
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
}

/**
 * Extracts and verifies the Firebase JWT from the Authorization header.
 * Returns null for unauthenticated requests — public queries still resolve.
 */
async function verifyToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      phone: decoded.phone_number || null,
      email: decoded.email || null,
    };
  } catch {
    return null;
  }
}

module.exports = { verifyToken };
