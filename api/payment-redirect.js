// ===================================================================
// GET/POST /api/payment-redirect?status=success|fail|cancel
// ===================================================================
// SSLCommerz পেমেন্ট শেষে ব্যবহারকারীর ব্রাউজারকে এখানে POST করে ফেরত পাঠায়।
// value_a-তে schoolId ফেরত আসে (আমরাই initiate-payment.js-এ পাঠিয়েছিলাম),
// তাই জানা যায় কোন স্কুলের কোন payment ডকুমেন্ট আপডেট করতে হবে।
//
// এই একটা ফাইলই তিনটা কাজ করে — success_url/fail_url/cancel_url সবগুলোই
// এই একই এন্ডপয়েন্টে আসে, শুধু ?status= প্যারামিটার আলাদা।

const { getAdmin } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
  const statusLabel = req.query.status || "fail"; // success | fail | cancel
  const body = req.body || {};
  const tranId = body.tran_id || req.query.tran_id || "";
  const schoolId = body.value_a || req.query.value_a || "";

  if (schoolId && tranId) {
    try {
      const admin = getAdmin();
      const db = admin.firestore();
      const newStatus =
        statusLabel === "success" ? "paid" : statusLabel === "fail" ? "failed" : "cancelled";

      await db
        .collection("schools")
        .doc(schoolId)
        .collection("payments")
        .doc(tranId)
        .set(
          {
            status: newStatus,
            ...(statusLabel === "success"
              ? { paidAt: admin.firestore.FieldValue.serverTimestamp() }
              : {}),
          },
          { merge: true }
        );
    } catch (e) {
      console.error("redirect-এ Firestore আপডেট এরর:", e.message);
    }
  }

  // ⚠️ Vercel Dashboard-এ APP_URL env var সেট না করলে ধরে নেওয়া হবে এই একই ডোমেইনের app.html
  const APP_URL = process.env.APP_URL || `https://${req.headers.host}/app.html`;
  res.redirect(
    302,
    `${APP_URL}?payment=${statusLabel}&tran_id=${encodeURIComponent(tranId)}&school_id=${encodeURIComponent(schoolId)}`
  );
};
