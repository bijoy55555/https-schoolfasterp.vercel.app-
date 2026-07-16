// ===================================================================
// Vercel সার্ভারলেস ফাংশনগুলোর জন্য শেয়ার্ড Firebase Admin SDK ইনিশিয়ালাইজার
// ===================================================================
// কেন দরকার: Vercel-এর প্রতিটা /api ফাংশন আলাদা আলাদা কল, তাই admin.initializeApp()
// একবারই (module-level cache) করে সব ফাংশন থেকে পুনরায় ব্যবহার করা হয়।
//
// ⚠️ Vercel Dashboard → Project → Settings → Environment Variables-এ
// এই একটা variable বসাতে হবে:
//   FIREBASE_SERVICE_ACCOUNT_B64
// মান হবে আপনার Firebase Service Account JSON ফাইলের সম্পূর্ণ কন্টেন্ট
// base64 করে (মাল্টিলাইন JSON সরাসরি env var-এ রাখলে সমস্যা হয়, তাই base64)।
//
// কীভাবে বানাবেন:
//   ১) Firebase Console → Project Settings → Service accounts →
//      "Generate new private key" — একটা .json ফাইল ডাউনলোড হবে
//   ২) টার্মিনালে (Mac/Linux): base64 -i সেই-ফাইল.json | tr -d '\n'
//      (Windows PowerShell): [Convert]::ToBase64String([IO.File]::ReadAllBytes("সেই-ফাইল.json"))
//   ৩) যা আউটপুট আসবে সেটাই FIREBASE_SERVICE_ACCOUNT_B64-এর মান হিসেবে Vercel-এ বসান

const admin = require("firebase-admin");

function getAdmin() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!b64) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_B64 env variable সেট করা নেই — Vercel Dashboard-এ এটা বসান।"
      );
    }
    const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin;
}

// অ্যাপ থেকে আসা Authorization: Bearer <idToken> হেডার যাচাই করে
// ব্যবহারকারীর uid ও custom claims (schoolId, role) ফেরত দেয়।
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
    return decoded; // { uid, schoolId, role, ... }
  } catch (e) {
    const err = new Error("টোকেন যাচাই ব্যর্থ হয়েছে — আবার লগইন করে চেষ্টা করুন।");
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { getAdmin, verifyRequestToken };
