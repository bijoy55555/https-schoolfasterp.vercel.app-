// ===================================================================
// /api/attendance-sync — অফলাইন সিঙ্ক কিউ এন্ডপয়েন্ট
// ইন্টারনেট না থাকলে ESP32/ZKTeco ডিভাইস স্ক্যানগুলো নিজের মেমোরি/SD কার্ডে জমা রাখবে,
// নেট ফিরলে এই এন্ডপয়েন্টে একসাথে (batch) পাঠিয়ে দেবে — প্রতিটা স্ক্যান হারিয়ে যাবে না।
//
// Body (JSON):
// {
//   "schoolId": "abc123",
//   "deviceId": "dev_xyz",
//   "apiKey":   "64-char-hex-...",
//   "scans": [
//     { "uid": "04A3B2C1", "ts": "2026-07-16T08:05:00+06:00" },
//     { "uid": "0B55EE10", "ts": "2026-07-16T08:07:12+06:00" }
//   ]
// }
// সর্বোচ্চ ৫০০টা স্ক্যান একবারে — এর বেশি হলে ডিভাইসকে একাধিক কলে ভাগ করে পাঠাতে হবে।
// ===================================================================
const { getAdmin } = require("../lib/firebaseAdmin");
const { verifyDevice, resolveAndMarkAttendance } = require("../lib/biometricAttendance");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "শুধু POST সমর্থিত" });
    return;
  }
  try {
    const { schoolId, deviceId, apiKey, scans } = req.body || {};
    if (!Array.isArray(scans) || scans.length === 0) {
      res.status(400).json({ error: "scans অ্যারে খালি — অন্তত একটা স্ক্যান দিতে হবে" });
      return;
    }
    if (scans.length > 500) {
      res.status(400).json({ error: "একবারে সর্বোচ্চ ৫০০টা স্ক্যান পাঠানো যাবে" });
      return;
    }

    const admin = getAdmin();
    const db = admin.firestore();
    const device = await verifyDevice(db, schoolId, deviceId, apiKey);

    const results = [];
    for (const scan of scans) {
      try {
        const r = await resolveAndMarkAttendance(admin, db, schoolId, {
          uid: scan.uid,
          studentId: scan.studentId,
          ts: scan.ts,
          source: device.data.type,
          deviceId,
        });
        results.push({ uid: scan.uid || scan.studentId, ok: true, ...r });
      } catch (e) {
        // একটা স্ক্যান ব্যর্থ হলেও (যেমন আনম্যাপড কার্ড) বাকি স্ক্যানগুলো প্রসেস চলতে থাকে
        results.push({ uid: scan.uid || scan.studentId, ok: false, error: e.message });
      }
    }

    await device.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    const successCount = results.filter((r) => r.ok).length;
    res.status(200).json({ ok: true, total: scans.length, success: successCount, failed: scans.length - successCount, results });
  } catch (e) {
    console.error("attendance-sync এরর:", e.message);
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "সার্ভার এরর" });
  }
};
