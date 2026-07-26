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

    const { studentId, amount, phone, email, feeType, schoolId } = req.body || {};

    if (!studentId || !amount) {
      res.status(400).json({ error: "studentId এবং amount দেওয়া বাধ্যতামূলক" });
      return;
    }
    const numericAmount = Number(amount);
    if (!(numericAmount > 0)) {
      res.status(400).json({ error: "amount একটা বৈধ ধনাত্মক সংখ্যা হতে হবে" });
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

    // ⚠️ সিকিউরিটি ফিক্স: amount আগে সরাসরি ক্লায়েন্ট থেকে বিশ্বাস করে নেওয়া হতো —
    // যে কারণে যে কোনো amount (যেমন ১ টাকা) পাঠিয়ে বড় বকেয়া ফি "পরিশোধিত" করানো
    // সম্ভব ছিল। এখন studentId দিয়ে students কালেকশন থেকে আসল নাম বের করে (client-এর
    // পাঠানো studentName আর বিশ্বাস করা হয় না), এবং fees কালেকশনে সেই ছাত্রের
    // বকেয়া/আংশিক এন্ট্রিগুলোর মধ্যে amount হুবহু মিলে এমন একটা এন্ট্রি খোঁজা হয় —
    // না মিললে পেমেন্টই শুরু হবে না।
    const studentSnap = await schoolRef.collection("students").doc(String(studentId)).get();
    if (!studentSnap.exists) {
      res.status(404).json({ error: "এই ছাত্র পাওয়া যায়নি" });
      return;
    }
    const verifiedStudentName = studentSnap.data().name;
    if (!verifiedStudentName) {
      res.status(400).json({ error: "ছাত্রের নাম খুঁজে পাওয়া যায়নি" });
      return;
    }

    const dueFeesSnap = await schoolRef
      .collection("fees")
      .where("student", "==", verifiedStudentName)
      .where("status", "in", ["বকেয়া", "আংশিক"])
      .get();

    const matchedFeeDoc = dueFeesSnap.docs.find((d) => Number(d.data().amount) === numericAmount);
    if (!matchedFeeDoc) {
      res.status(400).json({
        error:
          "এই পরিমাণ (৳" +
          numericAmount +
          ") এর সাথে মিলে এমন কোনো বকেয়া/আংশিক ফি এন্ট্রি পাওয়া যায়নি। ফি তালিকা থেকে সঠিক বকেয়া পরিমাণ বেছে আবার চেষ্টা করুন।",
      });
      return;
    }
    const matchedFeeId = matchedFeeDoc.id;
    const studentName = verifiedStudentName;

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
      total_amount: numericAmount,
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
      studentName,
      feeId: matchedFeeId,
      phone: phone || "",
      feeType: feeType || "",
      amount: numericAmount,
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
