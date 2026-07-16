const admin = require("firebase-admin");

function getAdmin() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env variable সেট করা নেই — Vercel Dashboard-এ এগুলো বসান।"
      );
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }
  return admin;
}

async function verifyRequestToken(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    const err = new Error("লগইন টোকেন পাওয়া যায়নি — অনুগ্রহ করে আবার লগইন করুন।");
    err.statusCode = 401;
    throw err;
  }
  const idToken = match[1];
  const adm = getAdmin();
  try {
    const decoded = await adm.auth().verifyIdToken(idToken);
    return decoded;
  } catch (e) {
    const err = new Error("টোকেন যাচাই ব্যর্থ হয়েছে — আবার লগইন করে চেষ্টা করুন।");
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { getAdmin, verifyRequestToken };
