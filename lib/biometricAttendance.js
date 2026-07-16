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

// স্ক্যানের সময়টাকে "HH:MM" ফরম্যাটে বের করে — ইন-টাইম/আউট-টাইম দেখানোর জন্য ব্যবহার হয়
function formatTimeHHMM(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
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

  // স্কুলের বায়োমেট্রিক সেটিংস থেকে "দেরি" ধরার সময়সীমা এবং অভিভাবক-নোটিশ অন/অফ পড়া হয়
  // (ঐচ্ছিক — সেটিংস না থাকলে সবসময় 'P' ধরা হবে এবং অটো-নোটিশ পাঠানো হবে না)
  let status = "P";
  let autoNotifyLate = false;
  try {
    const settingsSnap = await db.collection("schools").doc(schoolId).collection("settings").doc("biometric").get();
    if (settingsSnap.exists) {
      const s = settingsSnap.data();
      if (s.lateAfter) {
        const [lh, lm] = String(s.lateAfter).split(":").map(Number);
        const scanMinutes = scanDate.getHours() * 60 + scanDate.getMinutes();
        if (!isNaN(lh) && scanMinutes > lh * 60 + (lm || 0)) status = "L";
      }
      autoNotifyLate = s.autoNotifyLate !== false; // ডিফল্ট চালু থাকবে, স্পষ্টভাবে false করলে বন্ধ হবে
    } else {
      autoNotifyLate = true; // সেটিংস ডকুমেন্টই না থাকলেও ডিফল্ট আচরণ হলো অটো-নোটিশ চালু
    }
  } catch (e) {
    // সেটিংস না পড়া গেলেও হাজিরা মার্ক করা বন্ধ হবে না
  }

  // ===== ইন-টাইম / আউট-টাইম লজিক =====
  // একই ছাত্রের দিনের প্রথম স্ক্যান = ইন-টাইম (times.<নাম>.in), তারপরের প্রতিটা স্ক্যান
  // আউট-টাইম (times.<নাম>.out) আপডেট করে — ফলে সবশেষ স্ক্যানটাই সবসময় আউট-টাইম হিসেবে থাকে।
  const attRef = db.collection("schools").doc(schoolId).collection("attendance").doc(attDocId(cls, dk));
  const attSnap = await attRef.get();
  const existingTimes = (attSnap.exists && attSnap.data().times && attSnap.data().times[studentName]) || null;
  const timeStr = formatTimeHHMM(scanDate);

  // dot-notation দিয়ে শুধু এই ছাত্রের রেকর্ড/টাইম-ই merge হয় — একই ডকুমেন্টে অন্য ছাত্রদের
  // records/times একই সাথে থাকলেও (ম্যানুয়াল এন্ট্রি বা অন্য স্ক্যান থেকে) সেগুলো মুছে যায় না।
  const updatePayload = {
    cls,
    date: dk,
    [`records.${studentName}`]: status,
    updatedAt: new Date().toISOString(),
  };
  if (!existingTimes || !existingTimes.in) {
    updatePayload[`times.${studentName}.in`] = timeStr;
  } else {
    updatePayload[`times.${studentName}.out`] = timeStr;
  }

  await attRef.set(updatePayload, { merge: true });

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

  // ===== দেরিতে এলে অভিভাবক পোর্টালে অটোমেটিক নোটিশ =====
  // এটা schools/{id}/data/main এর parentMessages অ্যারেতে না লিখে আলাদা lateNotices
  // কালেকশনে যোগ (add) করা হয় — কারণ app.html প্রতি ২০ সেকেন্ডে পুরো data/main ডকুমেন্ট
  // ওভাররাইট করে অটো-সেভ করে, যা এখান থেকে সরাসরি লেখা কোনো এন্ট্রি মুছে ফেলতে পারত।
  // শুধু প্রথম স্ক্যানেই (in-time) নোটিশ পাঠানো হয়, যাতে বারবার স্ক্যানে বারবার নোটিশ না যায়।
  if (status === "L" && autoNotifyLate && (!existingTimes || !existingTimes.in)) {
    try {
      await db.collection("schools").doc(schoolId).collection("lateNotices").add({
        studentName,
        cls,
        dateKey: dk,
        time: timeStr,
        message: `${studentName} আজ ${timeStr}-এ বিদ্যালয়ে দেরি করে প্রবেশ করেছে।`,
        source: source || "rfid",
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // নোটিশ তৈরি ব্যর্থ হলেও হাজিরা মার্ক করা আটকাবে না
    }
  }

  const inTime = existingTimes && existingTimes.in ? existingTimes.in : timeStr;
  const outTime = existingTimes && existingTimes.in ? timeStr : (existingTimes ? existingTimes.out || null : null);

  return { studentName, cls, status, dateKey: dk, inTime, outTime };
}

module.exports = {
  hashApiKey,
  generateApiKey,
  dateKeyFromDate,
  attDocId,
  verifyDevice,
  resolveAndMarkAttendance,
};
