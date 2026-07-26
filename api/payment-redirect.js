const axios = require("axios");
const { getAdmin, markFeePaidForPayment } = require("../lib/firebaseAdmin");

// ⚠️ সিকিউরিটি ফিক্স: এটা SSLCommerz-এর success_url — ব্যবহারকারীর ব্রাউজার থেকে
// রিডাইরেক্ট হয়ে আসে, তাই এখানে status=success কুয়েরি-প্যারামিটার কখনো সরাসরি
// বিশ্বাস করা যাবে না (যে কেউ শুধু এই URL সরাসরি হিট করেই ফি "পরিশোধিত" দেখাতে
// পারতো)। payment-ipn.js-এর মতোই এখানে val_id দিয়ে SSLCommerz-এর নিজস্ব
// validationserverAPI-তে সার্ভার-টু-সার্ভার re-verify করা হচ্ছে, তারপরই status
// আপডেট হবে — শুধু ব্রাউজার-রিডাইরেক্ট কখনোই যথেষ্ট প্রমাণ না।
async function verifyWithSslcommerz(paymentSettings, valId) {
  if (!valId) return false;
  const IS_LIVE = !!paymentSettings.sslcommerzIsLive;
  const validationUrl = IS_LIVE
    ? "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
    : "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php";
  try {
    const resp = await axios.get(validationUrl, {
      params: {
        val_id: valId,
        store_id: paymentSettings.sslcommerzStoreId,
        store_passwd: paymentSettings.sslcommerzStorePassword,
        format: "json",
      },
      timeout: 15000,
    });
    return resp.data && (resp.data.status === "VALID" || resp.data.status === "VALIDATED");
  } catch (e) {
    console.error("payment-redirect: SSLCommerz validation কল ব্যর্থ:", e.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  const statusLabel = req.query.status || "fail";
  const body = req.body || {};
  const tranId = body.tran_id || req.query.tran_id || "";
  const schoolId = body.value_a || req.query.value_a || "";
  const valId = body.val_id || req.query.val_id || "";

  if (schoolId && tranId) {
    try {
      const admin = getAdmin();
      const db = admin.firestore();
      const schoolRef = db.collection("schools").doc(schoolId);
      const paymentRef = schoolRef.collection("payments").doc(tranId);

      // আগের payment ডকুমেন্ট থাকা বাধ্যতামূলক (initiate-payment.js-এই তৈরি হয়) —
      // না থাকলে এই tran_id/schoolId জোড়া বানোয়াট, কিছুই করা হবে না
      const paySnap = await paymentRef.get();
      if (!paySnap.exists) {
        console.warn("payment-redirect: অজানা tran_id/schoolId — সম্ভাব্য ভুয়া রিকোয়েস্ট:", tranId, schoolId);
      } else if (paySnap.data().status === "paid") {
        // ইতিমধ্যে (IPN বা আগের রিকোয়েস্টে) পেইড হয়ে গেছে — ডাবল-প্রসেস করার দরকার নেই
      } else if (statusLabel === "success") {
        const paymentSettingsSnap = await schoolRef.collection("settings").doc("payment").get();
        const paymentSettings = paymentSettingsSnap.exists ? paymentSettingsSnap.data() : {};
        const verified = await verifyWithSslcommerz(paymentSettings, valId);

        if (verified) {
          await paymentRef.set(
            { status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp(), verifiedByRedirect: true },
            { merge: true }
          );
          await markFeePaidForPayment(db, schoolId, tranId);
        } else {
          console.warn("payment-redirect: val_id যাচাই ব্যর্থ, paid মার্ক করা হয়নি:", tranId);
          // যাচাই ব্যর্থ হলে "paid" করা হবে না — IPN পরে সঠিকভাবে এলে সেটাই আসল আপডেট করবে
        }
      } else {
        const newStatus = statusLabel === "fail" ? "failed" : "cancelled";
        await paymentRef.set({ status: newStatus }, { merge: true });
      }
    } catch (e) {
      console.error("redirect-এ Firestore আপডেট এরর:", e.message);
    }
  }

  let origin = process.env.APP_URL || `https://${req.headers.host}`;
  origin = origin.replace(/\/+$/, "");
  origin = origin.replace(/\/app\.html$/, "");
  const APP_URL = `${origin}/app.html`;
  res.redirect(
    302,
    `${APP_URL}?payment=${statusLabel}&tran_id=${encodeURIComponent(tranId)}&school_id=${encodeURIComponent(schoolId)}`
  );
};
