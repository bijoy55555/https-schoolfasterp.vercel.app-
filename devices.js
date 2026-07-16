// ===================================================================
// /api/devices — RFID/ZKTeco/QR ডিভাইস ম্যানেজমেন্ট (শুধু স্কুল-অ্যাডমিন)
//   POST   → নতুন ডিভাইস রেজিস্টার করে, একবারই দেখানো apiKey রিটার্ন করে
//   GET    → স্কুলের সব ডিভাইসের তালিকা (apiKey ছাড়া)
//   DELETE → একটা ডিভাইস বাতিল/মুছে ফেলে ({ deviceId } body-তে দিতে হবে)
// এই এন্ডপয়েন্ট Firebase লগইন টোকেন দিয়ে সুরক্ষিত (অ্যাডমিন প্যানেল থেকে কল হয়) —
// ডিভাইস নিজে এটা কল করে না, ডিভাইস শুধু attendance-push.js কল করে।
// ===================================================================
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");
const { generateApiKey, hashApiKey } = require("../lib/biometricAttendance");

async function getSchoolIdForUser(db, uid) {
  const idxSnap = await db.collection("userIndex").doc(uid).get();
  if (!idxSnap.exists || !idxSnap.data().schoolId) {
    const err = new Error("এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই");
    err.statusCode = 403;
    throw err;
  }
  return idxSnap.data().schoolId;
}

module.exports = async function handler(req, res) {
  try {
    const decoded = await verifyRequestToken(req);
    const admin = getAdmin();
    const db = admin.firestore();
    const schoolId = await getSchoolIdForUser(db, decoded.uid);
    const devicesRef = db.collection("schools").doc(schoolId).collection("devices");

    if (req.method === "POST") {
      const { name, type, location, serialNumber } = req.body || {};
      if (!name || !type) {
        res.status(400).json({ error: "name ও type দেওয়া বাধ্যতামূলক" });
        return;
      }
      if (!["rfid", "zkteco", "qr", "app"].includes(type)) {
        res.status(400).json({ error: "type হতে হবে rfid, zkteco, qr অথবা app এর একটা" });
        return;
      }
      if (type === "zkteco" && !serialNumber) {
        res.status(400).json({ error: "ZKTeco ডিভাইসের জন্য Serial Number (SN) দেওয়া বাধ্যতামূলক" });
        return;
      }
      const apiKey = generateApiKey();
      const newDevRef = devicesRef.doc();
      await newDevRef.set({
        name,
        type,
        location: location || "",
        serialNumber: serialNumber || null,
        apiKeyHash: hashApiKey(apiKey),
        status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenAt: null,
      });
      // ZKTeco ডিভাইস নিজে schoolId/apiKey পাঠাতে পারে না — শুধু নিজের SN পাঠায়।
      // তাই SN → schoolId/deviceId খুঁজে বের করার জন্য একটা টপ-লেভেল লুকআপ ডকুমেন্ট
      // রাখা হলো (দেখুন api/zkteco-adms.js) — এটা শুধু Admin SDK থেকেই পড়া/লেখা হয়,
      // firestore.rules-এর ডিফল্ট deny-all ক্লায়েন্ট থেকে এটা সম্পূর্ণ বন্ধ রাখে।
      if (type === "zkteco") {
        await db.collection("zktecoDevices").doc(String(serialNumber)).set({
          schoolId,
          deviceId: newDevRef.id,
        });
      }
      // ⚠️ apiKey শুধু এই একবারই প্লেইন টেক্সটে ফেরত যায় — Firestore-এ শুধু হ্যাশ থাকে।
      // এটা এখনই কপি করে ডিভাইস ফার্মওয়্যার/সেটিংসে বসাতে হবে।
      res.status(200).json({ deviceId: newDevRef.id, apiKey, schoolId });
      return;
    }

    if (req.method === "GET") {
      const snap = await devicesRef.orderBy("createdAt", "desc").get();
      const devices = snap.docs.map((d) => {
        const v = d.data();
        return {
          id: d.id,
          name: v.name,
          type: v.type,
          location: v.location,
          serialNumber: v.serialNumber || null,
          status: v.status,
          createdAt: v.createdAt ? v.createdAt.toDate().toISOString() : null,
          lastSeenAt: v.lastSeenAt ? v.lastSeenAt.toDate().toISOString() : null,
        };
      });
      res.status(200).json({ devices });
      return;
    }

    if (req.method === "DELETE") {
      const { deviceId } = req.body || {};
      if (!deviceId) {
        res.status(400).json({ error: "deviceId দেওয়া বাধ্যতামূলক" });
        return;
      }
      const devSnap = await devicesRef.doc(deviceId).get();
      await devicesRef.doc(deviceId).set({ status: "revoked" }, { merge: true });
      // ZKTeco হলে SN লুকআপও মুছে দেওয়া হয়, নাহলে বাতিল হওয়ার পরও ডিভাইসের স্ক্যান প্রসেস হতে থাকবে
      if (devSnap.exists && devSnap.data().type === "zkteco" && devSnap.data().serialNumber) {
        await db.collection("zktecoDevices").doc(String(devSnap.data().serialNumber)).delete();
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "শুধু GET, POST, DELETE সমর্থিত" });
  } catch (e) {
    console.error("devices API এরর:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message || "সার্ভার এরর" });
  }
};
