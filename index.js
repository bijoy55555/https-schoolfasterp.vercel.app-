// ===================================================================
// স্কুল ERP — Cloud Functions (সার্ভার সাইড কোড)
// এই ফাইলে যা আছে তা ব্রাউজার থেকে দেখা যায় না — তাই API key,
// secret key এখানে রাখা নিরাপদ। এটাই আসল "ব্যাকএন্ড"।
// ===================================================================

const { onCall } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ===================================================================
// ১) SSLCommerz পেমেন্ট গেটওয়ে — ফি পেমেন্ট শুরু করার ফাংশন
// ===================================================================
// ব্যবহার (ফ্রন্টএন্ড থেকে): 
//   const startPayment = httpsCallable(functions, 'initiatePayment');
//   startPayment({ studentId, amount, studentName, phone })
//
// ⚠️ STORE_ID এবং STORE_PASSWORD Firebase Console-এর
// Environment Config / Secret Manager-এ রাখতে হবে, কোডে লেখা যাবে না।
exports.initiatePayment = onCall(async (request) => {
  const { studentId, amount, studentName, phone, email, feeType, schoolId } = request.data;

  if (!studentId || !amount) {
    throw new Error("studentId এবং amount দেওয়া বাধ্যতামূলক");
  }
  if (!schoolId) {
    throw new Error("schoolId দেওয়া বাধ্যতামূলক — কোন স্কুলের পেমেন্ট তা জানা দরকার");
  }

  // ⚠️ মডেল ২: প্রতিটা স্কুলের নিজস্ব SSLCommerz Store ID/Password —
  // এগুলো গ্লোবাল env variable থেকে না নিয়ে schools/{schoolId}/settings/payment
  // ডকুমেন্ট থেকে পড়া হয়, যাতে প্রতিটা স্কুলের টাকা সরাসরি তাদের নিজের
  // ব্যাংক অ্যাকাউন্টে যায়, আমাদের কাছে না।
  const schoolRef = db.collection("schools").doc(schoolId);
  const paymentSettingsSnap = await schoolRef.collection("settings").doc("payment").get();
  if (!paymentSettingsSnap.exists) {
    throw new Error("এই স্কুলের জন্য এখনো পেমেন্ট সেটআপ করা হয়নি। অ্যাডমিন প্যানেল → পেমেন্ট সেটিংস-এ গিয়ে SSLCommerz Store ID/Password বসান।");
  }
  const paymentSettings = paymentSettingsSnap.data();
  const STORE_ID = paymentSettings.sslcommerzStoreId;
  const STORE_PASSWORD = paymentSettings.sslcommerzStorePassword;
  const IS_LIVE = !!paymentSettings.sslcommerzIsLive; // স্কুল নিজেই সেটিংসে টিক দিয়ে sandbox/live বেছে নেবে

  if (!STORE_ID || !STORE_PASSWORD) {
    throw new Error("এই স্কুলের জন্য এখনো পেমেন্ট সেটআপ করা হয়নি। অ্যাডমিন প্যানেল → পেমেন্ট সেটিংস-এ গিয়ে SSLCommerz Store ID/Password বসান।");
  }

  const sslczUrl = IS_LIVE
    ? "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
    : "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";

  const tranId = `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ⚠️ এখানে আপনার আসল হোস্টিং ডোমেইন বসান (যেমন Vercel/Firebase Hosting URL)।
  // Firebase Console → Functions → Environment Variables-এ APP_URL সেট করলে সেটাই ব্যবহার হবে।
  const APP_URL = process.env.APP_URL || "https://schoolfasterp.vercel.app/app.html";
  const FUNCTIONS_BASE = process.env.FUNCTIONS_BASE_URL || "https://us-central1-school-erp-bd.cloudfunctions.net";

  const postData = {
    store_id: STORE_ID,
    store_passwd: STORE_PASSWORD,
    total_amount: amount,
    currency: "BDT",
    tran_id: tranId,
    // ✅ value_a দিয়ে schoolId পাঠানো হলো — SSLCommerz এটা অপরিবর্তিত রেখে IPN/redirect-এ
    // ফেরত পাঠায়, তাই পরে আমরা জানতে পারব এই লেনদেনটা কোন স্কুলের
    value_a: schoolId,
    // পেমেন্ট শেষে ব্রাউজার এই ৩টা ঠিকানার একটাতে ফিরে আসবে —
    // আমাদের নিজস্ব ফাংশন সেটা ধরে Firestore আপডেট করে, তারপর app.html-এ ফেরত পাঠায়
    success_url: `${FUNCTIONS_BASE}/paymentSuccessRedirect`,
    fail_url: `${FUNCTIONS_BASE}/paymentFailRedirect`,
    cancel_url: `${FUNCTIONS_BASE}/paymentCancelRedirect`,
    cus_name: studentName || "Student",
    cus_email: email || "student@example.com",
    cus_phone: phone || "01700000000",
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    shipping_method: "NO",
    product_name: feeType || "School Fee",
    product_category: "Education",
    product_profile: "general"
  };

  try {
    const response = await axios.post(sslczUrl, new URLSearchParams(postData));

    if (!response.data || response.data.status !== "SUCCESS") {
      console.error("SSLCommerz প্রত্যাখ্যান করেছে:", response.data);
      throw new Error(response.data?.failedreason || "SSLCommerz পেমেন্ট শুরু করতে রাজি হয়নি — Store ID/Password ঠিক আছে কিনা চেক করুন");
    }

    // ✅ লেনদেনের রেকর্ড স্কুলের নিজস্ব সাব-কালেকশনে সেভ করা হলো (schools/{schoolId}/payments/{tranId})
    // — অন্য কোনো স্কুলের ডেটার সাথে মিশবে না
    await schoolRef.collection("payments").doc(tranId).set({
      studentId,
      studentName: studentName || "",
      phone: phone || "",
      feeType: feeType || "",
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { paymentUrl: response.data.GatewayPageURL, tranId };
  } catch (error) {
    console.error("পেমেন্ট ইনিশিয়েট এরর:", error.message);
    throw new Error(error.message || "পেমেন্ট শুরু করা যায়নি, আবার চেষ্টা করুন");
  }
});

// SSLCommerz-এর সার্ভার-টু-সার্ভার নোটিফিকেশন (IPN) — টাকা আসলেই পাওয়া গেছে কিনা,
// এটাই সবচেয়ে নির্ভরযোগ্য উৎস, কারণ এটা ব্যবহারকারীর ব্রাউজার দিয়ে যায় না, সরাসরি SSLCommerz-এর
// সার্ভার থেকে আসে। মার্চেন্ট প্যানেলে "IPN URL" হিসেবে এই ফাংশনের ঠিকানা বসাতে হবে।
exports.paymentSuccessWebhook = onRequest(async (req, res) => {
  const { tran_id, status, value_a } = req.body;
  const schoolId = value_a;

  if (status === "VALID" && schoolId && tran_id) {
    await db.collection("schools").doc(schoolId).collection("payments").doc(tran_id).set({
      status: "paid",
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  res.status(200).send("OK");
});

// ===================================================================
// পেমেন্টের পর ব্রাউজারকে ফেরত পাঠানোর ফাংশন (success/fail/cancel)
// ===================================================================
// SSLCommerz পেমেন্ট শেষে ব্যবহারকারীর ব্রাউজারকে এই ৩টার একটাতে POST করে ফেরত পাঠায়,
// আর value_a-তে schoolId ফেরত আসে (আমরাই পাঠিয়েছিলাম) — তাই জানা যায় কোন স্কুলের ডকুমেন্ট আপডেট করতে হবে।
function buildPaymentRedirect(statusLabel) {
  return onRequest(async (req, res) => {
    const tranId = (req.body && req.body.tran_id) || req.query.tran_id || "";
    const schoolId = (req.body && req.body.value_a) || req.query.value_a || "";
    if (schoolId && tranId) {
      try {
        const newStatus = statusLabel === "success" ? "paid" : statusLabel === "fail" ? "failed" : "cancelled";
        await db.collection("schools").doc(schoolId).collection("payments").doc(tranId).set(
          {
            status: newStatus,
            ...(statusLabel === "success" ? { paidAt: admin.firestore.FieldValue.serverTimestamp() } : {})
          },
          { merge: true }
        );
      } catch (e) {
        console.error("redirect-এ Firestore আপডেট এরর:", e.message);
      }
    }
    const APP_URL = process.env.APP_URL || "https://schoolfasterp.vercel.app/app.html";
    res.redirect(302, `${APP_URL}?payment=${statusLabel}&tran_id=${encodeURIComponent(tranId)}&school_id=${encodeURIComponent(schoolId)}`);
  });
}
exports.paymentSuccessRedirect = buildPaymentRedirect("success");
exports.paymentFailRedirect = buildPaymentRedirect("fail");
exports.paymentCancelRedirect = buildPaymentRedirect("cancel");

// ===================================================================
// ২) SMS গেটওয়ে — বাংলাদেশি SMS প্রোভাইডার (যেমন BulkSMSBD) দিয়ে
// ===================================================================
// ব্যবহার (ফ্রন্টএন্ড থেকে):
//   const sendSms = httpsCallable(functions, 'sendSms');
//   sendSms({ phone: "01700000000", message: "আপনার সন্তান আজ অনুপস্থিত" })
exports.sendSms = onCall(async (request) => {
  const { phone, message } = request.data;

  if (!phone || !message) {
    throw new Error("ফোন নম্বর ও মেসেজ দেওয়া বাধ্যতামূলক");
  }

  // ⚠️ আপনার SMS প্রোভাইডারের API KEY ও SENDER ID বসান
  // (BulkSMSBD, Alpha SMS, Banglalink SMS Gateway — যেটাই ব্যবহার করেন)
  const SMS_API_KEY = process.env.SMS_API_KEY;
  const SMS_SENDER_ID = process.env.SMS_SENDER_ID;

  try {
    const response = await axios.post("https://bulksmsbd.net/api/smsapi", {
      api_key: SMS_API_KEY,
      senderid: SMS_SENDER_ID,
      number: phone,
      message: message
    });

    // SMS লগ Firestore-এ সেভ
    await db.collection("sms_logs").add({
      phone,
      message,
      status: response.data?.response_code === 202 ? "sent" : "failed",
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true };
  } catch (error) {
    console.error("SMS পাঠাতে এরর:", error.message);
    throw new Error("SMS পাঠানো যায়নি");
  }
});

// একসাথে অনেককে SMS পাঠানোর ফাংশন (যেমন: সব অভিভাবককে নোটিশ)
exports.sendBulkSms = onCall(async (request) => {
  const { phoneList, message } = request.data;

  if (!Array.isArray(phoneList) || phoneList.length === 0) {
    throw new Error("ফোন নম্বরের তালিকা দিতে হবে");
  }

  const SMS_API_KEY = process.env.SMS_API_KEY;
  const SMS_SENDER_ID = process.env.SMS_SENDER_ID;

  try {
    const response = await axios.post("https://bulksmsbd.net/api/smsapi", {
      api_key: SMS_API_KEY,
      senderid: SMS_SENDER_ID,
      number: phoneList.join(","),
      message: message
    });

    await db.collection("sms_logs").add({
      phoneCount: phoneList.length,
      message,
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, sentTo: phoneList.length };
  } catch (error) {
    console.error("বাল্ক SMS এরর:", error.message);
    throw new Error("বাল্ক SMS পাঠানো যায়নি");
  }
});

// ===================================================================
// ৩) বায়োমেট্রিক/RFID হাজিরা ডেটা গ্রহণ
// ===================================================================
// হাজিরা মেশিন/RFID রিডার থেকে ডেটা এই এন্ডপয়েন্টে পাঠানো হবে
// (ডিভাইসের নেটওয়ার্ক সেটিংসে এই URL বসাতে হবে)
exports.attendancePush = onRequest(async (req, res) => {
  const { cardId, deviceId, timestamp } = req.body;

  if (!cardId) {
    return res.status(400).send("কার্ড আইডি প্রয়োজন");
  }

  try {
    // কার্ড আইডি দিয়ে ছাত্র/শিক্ষক খুঁজে বের করা
    const userSnap = await db.collection("students")
      .where("rfidCard", "==", cardId).limit(1).get();

    if (userSnap.empty) {
      return res.status(404).send("এই কার্ডের সাথে কোনো ছাত্র যুক্ত নেই");
    }

    const student = userSnap.docs[0];

    await db.collection("attendance").add({
      studentId: student.id,
      studentName: student.data().name,
      deviceId: deviceId || "unknown",
      time: timestamp ? new Date(timestamp) : admin.firestore.FieldValue.serverTimestamp(),
      status: "present",
      source: "biometric"
    });

    res.status(200).send("হাজিরা রেকর্ড হয়েছে");
  } catch (error) {
    console.error("হাজিরা পুশ এরর:", error.message);
    res.status(500).send("সার্ভার এরর");
  }
});

// ===================================================================
// ৫) মাল্টি-স্কুল (মাল্টি-টেন্যান্ট) সিস্টেম
// ===================================================================
// প্রতিটা স্কুল = schools/{schoolId} ডকুমেন্ট
//   { name, ownerEmail, ownerPhone, package, price, expiryDate, status, createdAt }
// প্রতিটা ইউজারের Firebase Auth টোকেনে custom claim বসানো থাকে:
//   { schoolId: "...", role: "admin"|"principal"|"teacher"|"parent"|"student" }
// এই claim দিয়েই firestore.rules-এ প্রতিটা স্কুলের ডেটা আলাদা রাখা হয়।

// একবারই ব্যবহারের জন্য — নিজেকে "সুপার-অ্যাডমিন" (প্ল্যাটফর্ম মালিক) বানানো।
// আগে normal ইমেইল/পাসওয়ার্ড দিয়ে একটা Firebase Auth একাউন্ট বানান
// (Firebase Console > Authentication > Add user), তারপর ব্রাউজার কনসোল থেকে
// এই ফাংশন কল করুন secretKey সহ। secretKey আগে থেকে সিক্রেটে সেট করা থাকতে হবে:
//   firebase functions:secrets:set SUPERADMIN_SETUP_KEY
exports.bootstrapSuperAdmin = onCall(async (request) => {
  const { secretKey } = request.data;
  const expected = process.env.SUPERADMIN_SETUP_KEY;
  if (!expected || secretKey !== expected) {
    throw new Error("ভুল সিক্রেট কী — অনুমতি নেই");
  }
  if (!request.auth) {
    throw new Error("প্রথমে লগইন করুন, তারপর এই ফাংশন কল করুন");
  }
  await admin.auth().setCustomUserClaims(request.auth.uid, { superAdmin: true });
  return { success: true, message: "এখন আপনি সুপার-অ্যাডমিন। আবার লগইন করুন (sign out + sign in) যাতে নতুন claim কার্যকর হয়।" };
});

// নতুন স্কুল রেজিস্ট্রেশন — একজন সুপার-অ্যাডমিন (আপনি) এটা কল করবেন
// প্রতিটা নতুন স্কুল সাইনআপের সময়। এটা একইসাথে:
//  ১) স্কুলের জন্য একটা schools/{schoolId} ডকুমেন্ট বানায়
//  ২) স্কুলের প্রথম অ্যাডমিন ইউজারের জন্য Firebase Auth একাউন্ট বানায়
//  ৩) সেই ইউজারকে schoolId + role='admin' claim দেয়
//
// ব্যবহার (ফ্রন্টএন্ড / সুপার-অ্যাডমিন প্যানেল থেকে):
//   const createSchool = httpsCallable(functions, 'createSchool');
//   createSchool({ schoolName, adminEmail, adminPassword, adminName,
//                  ownerPhone, packageName, price, durationDays })
exports.createSchool = onCall(async (request) => {
  // ⚠️ শুধুমাত্র সুপার-অ্যাডমিন এটা কল করতে পারবে
  const callerClaims = request.auth?.token;
  if (!callerClaims || callerClaims.superAdmin !== true) {
    throw new Error("অনুমতি নেই — শুধু সুপার-অ্যাডমিন নতুন স্কুল যোগ করতে পারবেন");
  }

  const {
    schoolName, adminEmail, adminPassword, adminName,
    ownerPhone, packageName, price, durationDays
  } = request.data;

  if (!schoolName || !adminEmail || !adminPassword) {
    throw new Error("schoolName, adminEmail, adminPassword দেওয়া বাধ্যতামূলক");
  }

  const days = durationDays || 30;
  const expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  // স্কুল ডকুমেন্ট তৈরি
  const schoolRef = db.collection("schools").doc();
  const schoolId = schoolRef.id;

  await schoolRef.set({
    name: schoolName,
    ownerEmail: adminEmail,
    ownerPhone: ownerPhone || "",
    package: packageName || "Standard",
    price: price || 0,
    expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // অ্যাডমিন ইউজার তৈরি
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: adminName || "Admin"
    });
  } catch (error) {
    // স্কুল ডকুমেন্ট তৈরি হয়ে গেলেও ইউজার তৈরি ব্যর্থ হলে স্কুলটা মুছে ফেলা হলো
    await schoolRef.delete();
    throw new Error("অ্যাডমিন ইউজার তৈরি করা যায়নি: " + error.message);
  }

  await admin.auth().setCustomUserClaims(userRecord.uid, {
    schoolId, role: "admin"
  });

  await db.collection("schools").doc(schoolId)
    .collection("users").doc(userRecord.uid).set({
      name: adminName || "Admin",
      email: adminEmail,
      role: "admin",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

  return { schoolId, uid: userRecord.uid };
});

// একই স্কুলের নতুন ইউজার (শিক্ষক/অভিভাবক/ছাত্র) যোগ করা —
// স্কুলের নিজের অ্যাডমিনই এটা কল করবে
exports.addSchoolUser = onCall(async (request) => {
  const callerClaims = request.auth?.token;
  if (!callerClaims?.schoolId || callerClaims.role !== "admin") {
    throw new Error("অনুমতি নেই — শুধু স্কুল অ্যাডমিন নতুন ইউজার যোগ করতে পারবেন");
  }

  const { email, password, name, role } = request.data;
  if (!email || !password || !role) {
    throw new Error("email, password, role দেওয়া বাধ্যতামূলক");
  }

  const userRecord = await admin.auth().createUser({ email, password, displayName: name || "" });
  await admin.auth().setCustomUserClaims(userRecord.uid, {
    schoolId: callerClaims.schoolId, role
  });

  await db.collection("schools").doc(callerClaims.schoolId)
    .collection("users").doc(userRecord.uid).set({
      name: name || "", email, role,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

  return { uid: userRecord.uid };
});

// লগইনের পর ফ্রন্টএন্ড থেকে কল করে স্কুলের সাবস্ক্রিপশন এখনো সচল কিনা যাচাই
exports.checkSubscriptionStatus = onCall(async (request) => {
  const schoolId = request.auth?.token?.schoolId;
  if (!schoolId) throw new Error("এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই");

  const snap = await db.collection("schools").doc(schoolId).get();
  if (!snap.exists) throw new Error("স্কুল খুঁজে পাওয়া যায়নি");

  const data = snap.data();
  const expiry = data.expiryDate?.toDate ? data.expiryDate.toDate() : new Date(data.expiryDate);
  const isExpired = expiry.getTime() < Date.now();

  if (isExpired && data.status !== "expired") {
    await snap.ref.update({ status: "expired" });
  }

  return {
    schoolId,
    schoolName: data.name,
    package: data.package,
    status: isExpired ? "expired" : data.status,
    expiryDate: expiry.toISOString()
  };
});

// প্রতিদিন সব স্কুলের সাবস্ক্রিপশন চেক করা — মেয়াদ শেষ হলে ব্লক করা,
// মেয়াদ শেষ হওয়ার ৩ দিন আগে হলে SMS রিমাইন্ডার পাঠানো
exports.checkSubscriptions = onSchedule("every day 03:00", async (event) => {
  const now = Date.now();
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  const snap = await db.collection("schools").where("status", "==", "active").get();

  for (const doc of snap.docs) {
    const data = doc.data();
    const expiry = data.expiryDate?.toDate ? data.expiryDate.toDate() : new Date(data.expiryDate);
    const msLeft = expiry.getTime() - now;

    if (msLeft < 0) {
      await doc.ref.update({ status: "expired" });
      console.log(`⛔ মেয়াদ শেষ: ${data.name}`);
    } else if (msLeft < threeDaysMs && !data.reminderSent) {
      if (data.ownerPhone) {
        try {
          const SMS_API_KEY = process.env.SMS_API_KEY;
          const SMS_SENDER_ID = process.env.SMS_SENDER_ID;
          await axios.post("https://bulksmsbd.net/api/smsapi", {
            api_key: SMS_API_KEY,
            senderid: SMS_SENDER_ID,
            number: data.ownerPhone,
            message: `প্রিয় ${data.name}, আপনার স্কুল ERP সাবস্ক্রিপশনের মেয়াদ শীঘ্রই শেষ হবে। নবায়ন করতে যোগাযোগ করুন।`
          });
        } catch (e) { console.error("রিমাইন্ডার SMS এরর:", e.message); }
      }
      await doc.ref.update({ reminderSent: true });
      console.log(`🔔 রিমাইন্ডার পাঠানো হয়েছে: ${data.name}`);
    }
  }
});

// ===================================================================
// ৪) প্রতিদিন স্বয়ংক্রিয় ব্যাকআপ (Firestore এক্সপোর্ট)
// ===================================================================
// এটা প্রতিদিন রাত ২টায় Firestore-এর সব ডেটা একটা Cloud Storage
// বাকেটে এক্সপোর্ট করবে — এক্সিডেন্টাল ডিলিট/দুর্ঘটনা থেকে সুরক্ষা
const { GoogleAuth } = require("google-auth-library");

exports.dailyBackup = onSchedule("every day 02:00", async (event) => {
  const projectId = process.env.GCLOUD_PROJECT;
  const bucket = `gs://${projectId}-backups`;

  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"]
  });
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default):exportDocuments`;

  try {
    await axios.post(
      url,
      { outputUriPrefix: bucket },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    console.log("✅ দৈনিক ব্যাকআপ সফল হয়েছে");
  } catch (error) {
    console.error("ব্যাকআপ এরর:", error.message);
  }
});
