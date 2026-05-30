/**
 * One-shot script: delete a Firebase Auth user by email.
 * Usage: node src/scripts/delete_firebase_user.js <email>
 */
const admin = require('firebase-admin');
const path = require('path');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node src/scripts/delete_firebase_user.js <email>');
  process.exit(1);
}

const serviceAccount = require(path.resolve(__dirname, '../../firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

(async () => {
  try {
    const user = await admin.auth().getUserByEmail(email);
    console.log(`Found user: uid=${user.uid} email=${user.email}`);
    await admin.auth().deleteUser(user.uid);
    console.log(`Deleted Firebase user: ${email}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.log(`No Firebase user found for: ${email}`);
    } else {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
  process.exit(0);
})();
