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
  const { studentId, amount, studentName, phone, email } = request.data;

  if (!studentId || !amount) {
    throw new Error("studentId এবং amount দেওয়া বাধ্যতামূলক");
  }

  // ⚠️ এই দুটো ভ্যালু আপনার SSLCommerz মার্চেন্ট অ্যাকাউন্ট থেকে আসবে
  const STORE_ID = process.env.SSLCOMMERZ_STORE_ID;
  const STORE_PASSWORD = process.env.SSLCOMMERZ_STORE_PASSWORD;
  const IS_LIVE = false; // টেস্টের সময় false, রিয়েল পেমেন্টের সময় true

  const sslczUrl = IS_LIVE
    ? "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
    : "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";

  const tranId = `SCHOOL_${studentId}_${Date.now()}`;

  const postData = {
    store_id: STORE_ID,
    store_passwd: STORE_PASSWORD,
    total_amount: amount,
    currency: "BDT",
    tran_id: tranId,
    success_url: "https://আপনার-প্রজেক্ট.web.app/payment-success",
    fail_url: "https://আপনার-প্রজেক্ট.web.app/payment-fail",
    cancel_url: "https://আপনার-প্রজেক্ট.web.app/payment-cancel",
    cus_name: studentName || "Student",
    cus_email: email || "student@example.com",
    cus_phone: phone || "01700000000",
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    shipping_method: "NO",
    product_name: "School Fee",
    product_category: "Education",
    product_profile: "general"
  };

  try {
    const response = await axios.post(sslczUrl, new URLSearchParams(postData));

    // লেনদেনের রেকর্ড Firestore-এ "pending" অবস্থায় সেভ করা হলো
    await db.collection("payments").doc(tranId).set({
      studentId,
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { paymentUrl: response.data.GatewayPageURL, tranId };
  } catch (error) {
    console.error("পেমেন্ট ইনিশিয়েট এরর:", error.message);
    throw new Error("পেমেন্ট শুরু করা যায়নি, আবার চেষ্টা করুন");
  }
});

// SSLCommerz পেমেন্ট সফল হলে এই ওয়েবহুকে কল করবে
exports.paymentSuccessWebhook = onRequest(async (req, res) => {
  const { tran_id, status } = req.body;

  if (status === "VALID") {
    await db.collection("payments").doc(tran_id).update({
      status: "paid",
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  res.status(200).send("OK");
});

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
