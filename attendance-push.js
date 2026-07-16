// ===================================================================
// /api/attendance-push — RFID রিডার / ZKTeco ডিভাইস / QR অ্যাপ থেকে একটা স্ক্যান পাঠানোর এন্ডপয়েন্ট
// এটা পাবলিক এন্ডপয়েন্ট (Firebase লগইন লাগে না) কারণ IoT ডিভাইসের ফার্মওয়্যার Firebase Auth
// করতে পারে না — এর বদলে devices.js থেকে পাওয়া schoolId + deviceId + apiKey দিয়ে যাচাই হয়।
//
// Body (JSON):
// {
//   "schoolId": "abc123",
//   "deviceId": "dev_xyz",
//   "apiKey":   "64-char-hex-...",
//   "uid":      "04A3B2C1",      // RFID কার্ড UID / বায়োমেট্রিক টেমপ্লেট ID (rfidMap-এ ম্যাপ করা থাকতে হবে)
//   "studentId": "stu_12",       // (ঐচ্ছিক বিকল্প) QR/অ্যাপ থেকে সরাসরি স্টুডেন্ট আইডি — uid না থাকলে এটা লাগবে
//   "ts":       "2026-07-16T08:05:00+06:00", // ঐচ্ছিক, না দিলে সার্ভার সময় ব্যবহার হবে
//   "source":   "rfid" | "zkteco" | "qr" | "app"
// }
// ===================================================================
const { getAdmin } = require("../lib/firebaseAdmin");
const { verifyDevice, resolveAndMarkAttendance } = require("../lib/biometricAttendance");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "শুধু POST সমর্থিত" });
    return;
  }
  try {
    const { schoolId, deviceId, apiKey, uid, studentId, ts, source } = req.body || {};
    const admin = getAdmin();
    const db = admin.firestore();

    const device = await verifyDevice(db, schoolId, deviceId, apiKey);

    const result = await resolveAndMarkAttendance(admin, db, schoolId, {
      uid,
      studentId,
      ts,
      source: source || device.data.type,
      deviceId,
    });

    await device.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error("attendance-push এরর:", e.message);
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "সার্ভার এরর" });
  }
};
