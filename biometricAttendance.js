// ===================================================================
// Biometric / RFID Attendance — শেয়ার্ড হেল্পার
// এই ফাইলটা attendance-push.js এবং attendance-sync.js দুটোতেই ব্যবহার হয়,
// যাতে একই যাচাই/সেভ লজিক দুই জায়গায় কপি-পেস্ট না হয়।
// ===================================================================
const crypto = require("crypto");

// ডিভাইসের API Key প্লেইন টেক্সটে Firestore-এ সেভ না করে SHA-256 হ্যাশ করে রাখা হয়
// (ডেটাবেস কখনো ফাঁস হলেও আসল কী কেউ বের করতে পারবে না)।
function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey)).digest("hex");
}

function generateApiKey() {
  // 32 বাইট = 64 হেক্স ক্যারেক্টার — ডিভাইস ফার্মওয়্যারে বসানোর মতো যথেষ্ট র‍্যান্ডম কী
  return crypto.randomBytes(32).toString("hex");
}

function dateKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Firestore ডকুমেন্ট আইডিতে '/' চলে না — app.html-এর attDocId()-এর সাথে হুবহু মিলিয়ে রাখা হলো,
// যাতে ডিভাইস থেকে মার্ক করা হাজিরা app.html-এর "উপস্থিতি" পেজেই সরাসরি দেখা যায়।
function attDocId(cls, dk) {
  return `${cls}__${dk}`.replace(/\//g, "-");
}

// একটা নিবন্ধিত ডিভাইসের API Key যাচাই করে। সঠিক হলে ডিভাইস ডকুমেন্ট রিটার্ন করে।
async function verifyDevice(db, schoolId, deviceId, apiKey) {
  if (!schoolId || !deviceId || !apiKey) {
    const err = new Error("schoolId, deviceId ও apiKey — তিনটাই দেওয়া বাধ্যতামূলক");
    err.statusCode = 400;
    throw err;
  }
  const devRef = db.collection("schools").doc(schoolId).collection("devices").doc(deviceId);
  const devSnap = await devRef.get();
  if (!devSnap.exists) {
    const err = new Error("এই ডিভাইস আইডি খুঁজে পাওয়া যায়নি — অ্যাডমিন প্যানেল থেকে আগে ডিভাইস রেজিস্টার করুন");
    err.statusCode = 404;
    throw err;
  }
  const dev = devSnap.data();
  if (dev.status === "revoked") {
    const err = new Error("এই ডিভাইসের অ্যাক্সেস বাতিল করা হয়েছে");
    err.statusCode = 403;
    throw err;
  }
  if (dev.apiKeyHash !== hashApiKey(apiKey)) {
    const err = new Error("API Key ভুল — যাচাই ব্যর্থ হয়েছে");
    err.statusCode = 401;
    throw err;
  }
  return { ref: devRef, data: dev };
}

// একটা স্ক্যান (UID বা সরাসরি studentId) থেকে ছাত্র খুঁজে বের করে হাজিরা মার্ক করে।
// রিটার্ন করে { studentName, cls, status, dateKey } অথবা throw করে যদি ছাত্র/ম্যাপিং না পাওয়া যায়।
async function resolveAndMarkAttendance(admin, db, schoolId, { uid, studentId, ts, source, deviceId }) {
  let studentName = null;
  let cls = null;

  if (uid) {
    // RFID কার্ড / বায়োমেট্রিক ফিঙ্গারপ্রিন্ট আইডি → rfidMap থেকে ছাত্র বের করা হয়
    const mapSnap = await db.collection("schools").doc(schoolId).collection("rfidMap").doc(String(uid)).get();
    if (!mapSnap.exists) {
      const err = new Error(`UID "${uid}" কোনো ছাত্রের সাথে ম্যাপ করা নেই`);
      err.statusCode = 404;
      err.unmapped = true;
      throw err;
    }
    const map = mapSnap.data();
    studentName = map.studentName;
    cls = map.cls;
  } else if (studentId) {
    // QR / অ্যাপ থেকে সরাসরি studentId পাঠানো হলে students কালেকশন থেকে বের করা হয়
    const stuSnap = await db.collection("schools").doc(schoolId).collection("students").doc(String(studentId)).get();
    if (!stuSnap.exists) {
      const err = new Error(`Student ID "${studentId}" খুঁজে পাওয়া যায়নি`);
      err.statusCode = 404;
      throw err;
    }
    const stu = stuSnap.data();
    studentName = stu.name;
    cls = stu.cls;
  } else {
    const err = new Error("uid অথবা studentId — একটা দেওয়া বাধ্যতামূলক");
    err.statusCode = 400;
    throw err;
  }

  const scanDate = ts ? new Date(ts) : new Date();
  const dk = dateKeyFromDate(isNaN(scanDate.getTime()) ? new Date() : scanDate);

  // স্কুলের বায়োমেট্রিক সেটিংস থেকে "দেরি" ধরার সময়সীমা পড়া হয় (ঐচ্ছিক — না থাকলে সবসময় 'P')
  let status = "P";
  try {
    const settingsSnap = await db.collection("schools").doc(schoolId).collection("settings").doc("biometric").get();
    if (settingsSnap.exists) {
      const s = settingsSnap.data();
      if (s.lateAfter) {
        const [lh, lm] = String(s.lateAfter).split(":").map(Number);
        const scanMinutes = scanDate.getHours() * 60 + scanDate.getMinutes();
        if (!isNaN(lh) && scanMinutes > lh * 60 + (lm || 0)) status = "L";
      }
    }
  } catch (e) {
    // সেটিংস না পড়া গেলেও হাজিরা মার্ক করা বন্ধ হবে না
  }

  // dot-notation দিয়ে শুধু এই ছাত্রের রেকর্ডটাই merge হয় — একই ডকুমেন্টে অন্য ছাত্রদের
  // records একই সাথে থাকলেও (ম্যানুয়াল এন্ট্রি বা অন্য স্ক্যান থেকে) সেগুলো মুছে যায় না।
  const attRef = db.collection("schools").doc(schoolId).collection("attendance").doc(attDocId(cls, dk));
  await attRef.set(
    {
      cls,
      date: dk,
      [`records.${studentName}`]: status,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  await db.collection("schools").doc(schoolId).collection("attendanceLogs").add({
    uid: uid || null,
    studentId: studentId || null,
    studentName,
    cls,
    status,
    dateKey: dk,
    deviceId: deviceId || null,
    source: source || "rfid",
    scanTs: scanDate.toISOString(),
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { studentName, cls, status, dateKey: dk };
}

module.exports = {
  hashApiKey,
  generateApiKey,
  dateKeyFromDate,
  attDocId,
  verifyDevice,
  resolveAndMarkAttendance,
};
