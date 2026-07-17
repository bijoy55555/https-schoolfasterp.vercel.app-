// ===================================================================
// /api/delete-school.js — সুপার-অ্যাডমিন প্যানেল থেকে একটা স্কুল সম্পূর্ণভাবে মুছে ফেলা
//
// ⚠️ এটা একটা ধ্বংসাত্মক (destructive) ও অপরিবর্তনীয় (irreversible) অপারেশন।
// এই এন্ডপয়েন্ট কল হলে নিচের সবকিছু চিরতরে মুছে যাবে:
//   1) schools/{schoolId} ডকুমেন্ট ও তার ভেতরের সব সাব-কালেকশন (students,
//      attendance, attendanceLogs, fees, results, devices, rfidMap,
//      lateNotices, backups, users, payments — যা কিছু আছে সব) —
//      Firebase Admin SDK-এর recursiveDelete() দিয়ে, তাই নতুন কোনো
//      সাব-কালেকশন যোগ হলেও সেটাও এর আওতায় পড়বে, আলাদা করে লিস্ট করার
//      দরকার নেই।
//   2) schools/{schoolId}/users-এ পাওয়া প্রতিটা UID-এর জন্য userIndex/{uid}
//      ডকুমেন্ট।
//   3) সেই UID-গুলোর Firebase Authentication একাউন্ট (অ্যাডমিন/শিক্ষক/
//      অভিভাবক/ছাত্র লগইন — যা-ই থাকুক) — যাতে ভবিষ্যতে সেই ইমেইল দিয়ে
//      পুরনো (এতিম) একাউন্টে লগইনের চেষ্টা করা না যায়।
//
// শুধুমাত্র superAdmins কালেকশনে থাকা UID দিয়ে অনুরোধ করলেই কাজ করে —
// অন্য কেউ (স্কুলের অ্যাডমিন সহ) এটা কল করতে পারবে না।
//
// Body (JSON): { "schoolId": "abc123" }
// Header:      Authorization: Bearer <সুপার-অ্যাডমিনের Firebase ID token>
// ===================================================================
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "শুধু POST সমর্থিত" });
    return;
  }

  try {
    const decoded = await verifyRequestToken(req); // থ্রো করবে যদি টোকেন অবৈধ হয়
    const admin = getAdmin();
    const db = admin.firestore();

    // ✅ সুপার-অ্যাডমিন যাচাই — শুধু superAdmins/{uid} ডকুমেন্ট থাকা ইউজারই মুছতে পারবে
    const saSnap = await db.collection("superAdmins").doc(decoded.uid).get();
    if (!saSnap.exists) {
      res.status(403).json({ ok: false, error: "আপনি সুপার-অ্যাডমিন নন — এই কাজ করার অনুমতি নেই।" });
      return;
    }

    const { schoolId } = req.body || {};
    if (!schoolId || typeof schoolId !== "string") {
      res.status(400).json({ ok: false, error: "schoolId দিন" });
      return;
    }

    const schoolRef = db.collection("schools").doc(schoolId);
    const schoolSnap = await schoolRef.get();
    if (!schoolSnap.exists) {
      res.status(404).json({ ok: false, error: "এই স্কুল পাওয়া যায়নি (হয়তো আগেই মোছা হয়েছে)।" });
      return;
    }
    const schoolName = schoolSnap.data().name || schoolId;

    // ধাপ ১: এই স্কুলের সব ইউজার (অ্যাডমিন/শিক্ষক/অভিভাবক/ছাত্র লগইন UID) খুঁজে বের করা,
    // যাতে Firestore ডকুমেন্ট মোছার পর তাদের Auth একাউন্ট ও userIndex এন্ট্রিও মোছা যায়
    const userUids = [];
    try {
      const usersSnap = await schoolRef.collection("users").get();
      usersSnap.forEach((d) => userUids.push(d.id));
    } catch (e) {
      console.warn("users সাব-কালেকশন পড়া যায়নি:", e.message);
    }

    // ধাপ ২: পুরো স্কুল ডকুমেন্ট + তার সব সাব-কালেকশন recursively মুছে ফেলা
    // (students, attendance, attendanceLogs, fees, results, devices, rfidMap,
    //  lateNotices, backups, payments, users — সবকিছু, নতুন যা যোগ হয়েছে তাও)
    await db.recursiveDelete(schoolRef);

    // ধাপ ৩: userIndex/{uid} এন্ট্রি ও Firebase Auth একাউন্ট মোছা (প্রতিটার জন্য আলাদা
    // try-catch, যাতে একটায় সমস্যা হলেও বাকিগুলো চলতে থাকে)
    const authDeleteResults = [];
    for (const uid of userUids) {
      try {
        await db.collection("userIndex").doc(uid).delete();
      } catch (e) {
        console.warn(`userIndex/${uid} মোছা যায়নি:`, e.message);
      }
      try {
        await admin.auth().deleteUser(uid);
        authDeleteResults.push({ uid, ok: true });
      } catch (e) {
        // ইউজার আগেই Auth থেকে মুছে গিয়ে থাকতে পারে, বা অন্য কোনো কারণে ব্যর্থ হতে পারে —
        // এটা মূল অপারেশনকে ব্যর্থ করবে না, শুধু লগ করে রাখা হবে
        authDeleteResults.push({ uid, ok: false, error: e.message });
      }
    }

    res.status(200).json({
      ok: true,
      schoolId,
      schoolName,
      deletedUserAccounts: authDeleteResults,
      message: `"${schoolName}" স্কুলের সব ডেটা (ছাত্র, হাজিরা, ফি, রেজাল্ট, ডিভাইস, লগইন — সবকিছু) স্থায়ীভাবে মুছে ফেলা হয়েছে।`,
    });
  } catch (e) {
    console.error("delete-school এরর:", e.message);
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "সার্ভার এরর" });
  }
};
