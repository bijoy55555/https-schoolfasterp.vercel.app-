// ===================================================================
// /api/rfid-map — RFID কার্ড UID / বায়োমেট্রিক ID ↔ ছাত্র ম্যাপিং (শুধু স্কুল-অ্যাডমিন)
//   POST   → নতুন ম্যাপিং যোগ/আপডেট করে ({ uid, studentId, studentName, cls })
//   GET    → সব ম্যাপিং তালিকা
//   DELETE → একটা ম্যাপিং মুছে ফেলে ({ uid } body-তে)
// ===================================================================
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");

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
    const mapRef = db.collection("schools").doc(schoolId).collection("rfidMap");

    if (req.method === "POST") {
      const { uid, studentId, studentName, cls } = req.body || {};
      if (!uid || !studentName || !cls) {
        res.status(400).json({ error: "uid, studentName ও cls দেওয়া বাধ্যতামূলক" });
        return;
      }
      await mapRef.doc(String(uid)).set({
        uid: String(uid),
        studentId: studentId || null,
        studentName,
        cls,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "GET") {
      const snap = await mapRef.orderBy("cls").get();
      const mappings = snap.docs.map((d) => ({ id: d.id, ...d.data(), updatedAt: undefined }));
      res.status(200).json({ mappings });
      return;
    }

    if (req.method === "DELETE") {
      const { uid } = req.body || {};
      if (!uid) {
        res.status(400).json({ error: "uid দেওয়া বাধ্যতামূলক" });
        return;
      }
      await mapRef.doc(String(uid)).delete();
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "শুধু GET, POST, DELETE সমর্থিত" });
  } catch (e) {
    console.error("rfid-map API এরর:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message || "সার্ভার এরর" });
  }
};
