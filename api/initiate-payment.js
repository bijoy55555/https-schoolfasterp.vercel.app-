// ===================================================================
// POST /api/initiate-payment
// ===================================================================
const axios = require("axios");
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "শুধু POST মেথড সমর্থিত" });
    return;
  }

  try {
    const decoded = await verifyRequestToken(req);

    const { studentId, amount, studentName, phone, email, feeType, schoolId } = req.body || {};

    if (!studentId || !amount) {
      res.status(400).json({ error: "studentId এবং amount দেওয়া বাধ্যতামূলক" });
      return;
    }

    const admin = getAdmin();
    const db = admin.firestore();

    const idxSnap = await db.collection("userIndex").doc(decoded.uid).get();
    if (!idxSnap.exists || !idxSnap.data().schoolId) {
      res.status(403).json({ error: "এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই" });
      return;
    }
    const tokenSchoolId = idxSnap.data().schoolId;
    if (schoolId && schoolId !== tokenSchoolId) {
      res.status(403).json({ error: "অনুমতি নেই — schoolId মিলছে না" });
      return;
    }
    const finalSchoolId = tokenSchoolId;

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

    const origin = process.env.APP_URL || `https://${req.headers.host}`;

    const postData = {
      store_id: STORE_ID,
      store_passwd: STORE_PASSWORD,
      total_amount: amount,
      currency: "BDT",
      tran_id: tranId,
      value_a: finalSchoolId,
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
