// ===================================================================
// POST /api/payment-ipn
// ===================================================================
// SSLCommerz-এর সার্ভার-টু-সার্ভার নোটিফিকেশন (IPN) — এটাই সবচেয়ে নির্ভরযোগ্য
// উৎস, কারণ ব্যবহারকারীর ব্রাউজার দিয়ে যায় না, সরাসরি SSLCommerz-এর সার্ভার
// থেকে আসে (তাই কেউ ব্রাউজার থেকে জাল রিকোয়েস্ট পাঠিয়ে "paid" বানাতে পারবে না,
// যেহেতু নিচে আমরা val_id দিয়ে আবার SSLCommerz-এর কাছেই যাচাই করছি)।
//
// ⚠️ SSLCommerz মার্চেন্ট প্যানেল → Settings → IPN URL-এ এই ঠিকানা বসাতে হবে:
//   https://আপনার-ডোমেইন.vercel.app/api/payment-ipn

const axios = require("axios");
const { getAdmin } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("শুধু POST সমর্থিত");
    return;
  }

  const { tran_id, val_id, status, value_a } = req.body || {};
  const schoolId = value_a;

  if (status !== "VALID" || !schoolId || !tran_id || !val_id) {
    // SSLCommerz-কে সবসময় 200 দিতে হয়, নাহলে ওরা বারবার রিট্রাই পাঠাতে থাকবে
    res.status(200).send("IGNORED");
    return;
  }

  try {
    const admin = getAdmin();
    const db = admin.firestore();

    // ✅ নিরাপত্তা যাচাই: val_id দিয়ে SSLCommerz-এর নিজস্ব Validation API-তে
    // আবার জিজ্ঞাসা করা হচ্ছে লেনদেনটা সত্যিই বৈধ কিনা — শুধু IPN বডি বিশ্বাস
    // করলে যে কেউ জাল POST পাঠিয়ে ফি "পরিশোধিত" দেখাতে পারত
    const paymentSettingsSnap = await db
      .collection("schools")
      .doc(schoolId)
      .collection("settings")
      .doc("payment")
      .get();
    const paymentSettings = paymentSettingsSnap.exists ? paymentSettingsSnap.data() : {};
    const STORE_ID = paymentSettings.sslcommerzStoreId;
    const STORE_PASSWORD = paymentSettings.sslcommerzStorePassword;
    const IS_LIVE = !!paymentSettings.sslcommerzIsLive;

    const validationUrl = IS_LIVE
      ? "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
      : "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php";

    const verifyResp = await axios.get(validationUrl, {
      params: {
        val_id,
        store_id: STORE_ID,
        store_passwd: STORE_PASSWORD,
        format: "json",
      },
    });

    const verified =
      verifyResp.data &&
      (verifyResp.data.status === "VALID" || verifyResp.data.status === "VALIDATED");

    if (verified) {
      await db
        .collection("schools")
        .doc(schoolId)
        .collection("payments")
        .doc(tran_id)
        .set(
          {
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            verifiedByIpn: true,
          },
          { merge: true }
        );
    } else {
      console.warn("IPN এসেছে কিন্তু validation API-তে যাচাই ব্যর্থ হয়েছে:", tran_id);
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("IPN হ্যান্ডলার এরর:", e.message);
    // ব্যর্থ হলেও 200 পাঠানো হচ্ছে যাতে SSLCommerz অন্তহীন রিট্রাই না করে —
    // এরর লগে দেখা যাবে, প্রয়োজনে ম্যানুয়ালি ঠিক করা যাবে
    res.status(200).send("ERROR_LOGGED");
  }
};
