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

module.exports = { getAdmin, verifyRequestToken, markFeePaidForPayment };

async function markFeePaidForPayment(db, schoolId, tranId) {
  const payRef = db.collection("schools").doc(schoolId).collection("payments").doc(tranId);
  const paySnap = await payRef.get();
  if (!paySnap.exists) return;
  const pay = paySnap.data();
  const studentName = pay.studentName;
  if (!studentName) return;

  const feesRef = db.collection("schools").doc(schoolId).collection("fees");
  const dueSnap = await feesRef
    .where("student", "==", studentName)
    .where("status", "==", "বকেয়া")
    .limit(1)
    .get();

  if (!dueSnap.empty) {
    const feeDoc = dueSnap.docs[0];
    await feeDoc.ref.set(
      {
        status: "পরিশোধিত",
        method: "অনলাইন (SSLCommerz)",
        onlinePaidAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    const now = new Date();
    const months = ["জানুয়ারি","ফেব্রুয়ারি","মার্চ","এপ্রিল","মে","জুন","জুলাই","আগস্ট","সেপ্টেম্বর","অক্টোবর","নভেম্বর","ডিসেম্বর"];
    const newId = "fee_online_" + tranId;
    await feesRef.doc(newId).set({
      id: newId,
      student: studentName,
      cls: "",
      type: pay.feeType || "অনলাইন পেমেন্ট",
      amount: pay.amount,
      date: `${now.getDate()} ${months[now.getMonth()]}`,
      month: now.getMonth(),
      method: "অনলাইন (SSLCommerz)",
      status: "পরিশোধিত",
      onlinePaidAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
    });
  }
}
