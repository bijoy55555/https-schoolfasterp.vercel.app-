// ===================================================================
// POST /api/initiate-payment
// ===================================================================
// আগে এটা Firebase Cloud Function (initiatePayment, httpsCallable) ছিল —
// এখন এটাই কাজ করছে, কিন্তু Vercel-এ, যাতে Firebase Blaze প্ল্যান না লাগে।
// ফ্রন্টএন্ড থেকে fetch('/api/initiate-payment', { method:'POST', ... }) দিয়ে কল হয়।

const axios = require("axios");
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "শুধু POST মেথড সমর্থিত" });
    return;
  }

  try {
    // ১) লগইন যাচাই — যে কেউ এই এন্ডপয়েন্ট কল করে টাকা শুরু করাতে পারবে না,
    //    শুধু বৈধ Firebase Auth টোকেনধারী ব্যবহারকারীই পারবে
    const decoded = await verifyRequestToken(req);

    const { studentId, amount, studentName, phone, email, feeType, schoolId } = req.body || {};

    if (!studentId || !amount) {
      res.status(400).json({ error: "studentId এবং amount দেওয়া বাধ্যতামূলক" });
      return;
    }
    // টোকেনে থাকা schoolId-ই আসল সত্য — body-তে schoolId থাকলেও টোকেনের সাথে মিলতে হবে,
    // নাহলে একজন অন্য স্কুলের নামে পেমেন্ট শুরু করাতে পারবে
    const tokenSchoolId = decoded.schoolId;
    if (!tokenSchoolId) {
      res.status(403).json({ error: "এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই" });
      return;
    }
    if (schoolId && schoolId !== tokenSchoolId) {
      res.status(403).json({ error: "অনুমতি নেই — schoolId মিলছে না" });
      return;
    }
    const finalSchoolId = tokenSchoolId;

    const admin = getAdmin();
    const db = admin.firestore();
    const schoolRef = db.collection("schools").doc(finalSchoolId);

    const paymentSettingsSnap = await schoolRef.collection("settings").doc("payment").get();
    if (!paymentSettingsSnap.exists) {
      res.status(412).json({
        error:
          "এই স্কুলের জন্য এখনো পেমেন্ট সেটআপ করা হয়নি। অ্যাডমিন প্যানেল → পেমেন্ট সেটিংস-এ গিয়ে SSLCommerz Store ID/Password বসান।",
      });
      return;
    }
    const paymentSettings = paymentSettingsSnap.data();
    const STORE_ID = paymentSettings.sslcommerzStoreId;
    const STORE_PASSWORD = paymentSettings.sslcommerzStorePassword;
    const IS_LIVE = !!paymentSettings.sslcommerzIsLive;

    if (!STORE_ID || !STORE_PASSWORD) {
      res.status(412).json({
        error:
          "এই স্কুলের জন্য এখনো পেমেন্ট সেটআপ করা হয়নি। অ্যাডমিন প্যানেল → পেমেন্ট সেটিংস-এ গিয়ে SSLCommerz Store ID/Password বসান।",
      });
      return;
    }

    const sslczUrl = IS_LIVE
      ? "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
      : "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";

    const tranId = `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // ⚠️ আপনার আসল ডোমেইন — Vercel-এ deploy হওয়া এই একই প্রজেক্টের ডোমেইন।
    // env var APP_URL সেট না থাকলে রিকোয়েস্ট যেই হোস্ট থেকে এসেছে সেটাই ব্যবহার হবে।
    const origin = process.env.APP_URL || `https://${req.headers.host}`;

    const postData = {
      store_id: STORE_ID,
      store_passwd: STORE_PASSWORD,
      total_amount: amount,
      currency: "BDT",
      tran_id: tranId,
      value_a: finalSchoolId, // IPN/redirect-এ ফেরত আসবে, তাই কোন স্কুলের লেনদেন তা জানা যাবে
      success_url: `${origin}/api/payment-redirect?status=success`,
      fail_url: `${origin}/api/payment-redirect?status=fail`,
      cancel_url: `${origin}/api/payment-redirect?status=cancel`,
      cus_name: studentName || "Student",
      cus_email: email || "student@example.com",
      cus_phone: phone || "01700000000",
      cus_add1: "Dhaka",
      cus_city: "Dhaka",
      cus_country: "Bangladesh",
      shipping_method: "NO",
      product_name: feeType || "School Fee",
      product_category: "Education",
      product_profile: "general",
    };

    const response = await axios.post(sslczUrl, new URLSearchParams(postData));

    if (!response.data || response.data.status !== "SUCCESS") {
      console.error("SSLCommerz প্রত্যাখ্যান করেছে:", response.data);
      res.status(502).json({
        error:
          response.data?.failedreason ||
          "SSLCommerz পেমেন্ট শুরু করতে রাজি হয়নি — Store ID/Password ঠিক আছে কিনা চেক করুন",
      });
      return;
    }

    // লেনদেনের রেকর্ড স্কুলের নিজস্ব সাব-কালেকশনে সেভ — schools/{schoolId}/payments/{tranId}
    await schoolRef.collection("payments").doc(tranId).set({
      studentId,
      studentName: studentName || "",
      phone: phone || "",
      feeType: feeType || "",
      amount,
      status: "pending",
      createdBy: decoded.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ paymentUrl: response.data.GatewayPageURL, tranId });
  } catch (error) {
    console.error("পেমেন্ট ইনিশিয়েট এরর:", error.message);
    res
      .status(error.statusCode || 500)
      .json({ error: error.message || "পেমেন্ট শুরু করা যায়নি, আবার চেষ্টা করুন" });
  }
};
