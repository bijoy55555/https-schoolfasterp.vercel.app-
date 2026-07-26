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

  // ✅ সিকিউরিটি ফিক্স: initiate-payment.js এখন প্রতিটা পেমেন্ট রেকর্ডে ঠিক কোন fee
  // এন্ট্রির বিপরীতে টাকা দেওয়া হচ্ছে তার নির্দিষ্ট feeId সেভ করে রাখে। সেটা থাকলে
  // ঠিক সেই এন্ট্রিটাই "পরিশোধিত" করা হয় — "student নামে প্রথম যে বকেয়া এন্ট্রি
  // পাওয়া যায়" সেটা অনুমান করে ধরে নেওয়া হয় না (আগে এভাবেই amount না মিলিয়ে ভুল/
  // ইচ্ছাকৃতভাবে ছোট এন্ট্রি "পরিশোধিত" দেখানো সম্ভব ছিল)। পুরনো/legacy পেমেন্ট
  // রেকর্ডে feeId না থাকলে (এই ফিক্সের আগে তৈরি) আগের ফলব্যাক লজিক ব্যবহার হয়।
  let feeDoc = null;
  if (pay.feeId) {
    const directRef = feesRef.doc(pay.feeId);
    const directSnap = await directRef.get();
    if (directSnap.exists) feeDoc = directSnap;
  }
  if (!feeDoc) {
    const dueSnap = await feesRef
      .where("student", "==", studentName)
      .where("status", "==", "বকেয়া")
      .limit(1)
      .get();
    if (!dueSnap.empty) feeDoc = dueSnap.docs[0];
  }

  if (feeDoc) {
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

  // ✅ বাগ-ফিক্স: এতদিন এখানে শুধু fees কালেকশনের এন্ট্রি "পরিশোধিত" করা হতো, কিন্তু students
  // কালেকশনে ছাত্রের নিজের feeStatus ফিল্ডটা কখনো আপডেট হতো না — যার কারণে অভিভাবক পোর্টাল ও
  // ফি ম্যানেজমেন্টে "পরিশোধিত" দেখালেও ছাত্র তালিকায় পুরনো "বকেয়া" থেকে যেত। এখন পেমেন্টের পর
  // ছাত্রের বাকি সব fees এন্ট্রি চেক করে students ডকুমেন্টের feeStatus-ও সবসময় সিঙ্ক করে দেওয়া হয়।
  const studentsRef = db.collection("schools").doc(schoolId).collection("students");
  const [studentSnap, remainingFeesSnap] = await Promise.all([
    studentsRef.where("name", "==", studentName).limit(1).get(),
    feesRef.where("student", "==", studentName).get(),
  ]);

  if (!studentSnap.empty) {
    const remainingFees = remainingFeesSnap.docs.map((d) => d.data());
    const hasDue = remainingFees.some((f) => f.status === "বকেয়া");
    const hasPartial = remainingFees.some((f) => f.status === "আংশিক");
    const newFeeStatus = hasDue ? "বকেয়া" : hasPartial ? "আংশিক" : "পরিশোধিত";
    await studentSnap.docs[0].ref.set({ feeStatus: newFeeStatus }, { merge: true });
  }
    }
