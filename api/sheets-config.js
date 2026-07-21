// ===================================================================
// /api/sheets-config — স্কুলের নিজস্ব Google Sheet কানেক্ট/ডিসকানেক্ট করার এন্ডপয়েন্ট
//   GET    → এই স্কুলের বর্তমান কানেকশন স্ট্যাটাস + কোন ইমেইল শেয়ার করতে হবে তা দেখায়
//   POST   → { spreadsheetId } (বা পুরো Sheet URL) দিয়ে এই স্কুলের সাথে Sheet কানেক্ট করে
//   DELETE → এই স্কুলের Sheet কানেকশন বিচ্ছিন্ন করে (Sheet নিজে মোছে না)
//
// schoolId কখনো request body থেকে বিশ্বাস করে নেওয়া হয় না — সবসময় লগইন করা
// ইউজারের userIndex/{uid} থেকে বের করা হয় (api/devices.js-এর মতো একই প্যাটার্ন),
// তাই কোনো স্কুল-অ্যাডমিন অন্য স্কুলের Sheet কানেক্ট/দেখা/মোছা — কিছুই করতে পারবে না।
// শুধু superAdmins/{uid}-এ থাকা ইউজার ?schoolId=... দিয়ে যেকোনো স্কুলের কানেকশন দেখতে পারবে।
// ===================================================================
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");
const { serviceAccountEmail, extractSpreadsheetId, verifySpreadsheetAccess } = require("../lib/googleSheets");

async function resolveSchoolId(db, decoded, req) {
  const saSnap = await db.collection("superAdmins").doc(decoded.uid).get();
  if (saSnap.exists) {
    const requested = (req.query && req.query.schoolId) || (req.body && req.body.schoolId);
    if (!requested) {
      const err = new Error("সুপার-অ্যাডমিন হিসেবে schoolId (query/body-তে) দিতে হবে");
      err.statusCode = 400;
      throw err;
    }
    return { schoolId: requested, isSuperAdmin: true };
  }
  const idxSnap = await db.collection("userIndex").doc(decoded.uid).get();
  if (!idxSnap.exists || !idxSnap.data().schoolId) {
    const err = new Error("এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই");
    err.statusCode = 403;
    throw err;
  }
  if (idxSnap.data().role !== "admin") {
    const err = new Error("শুধু স্কুল-অ্যাডমিন Google Sheet কানেক্ট করতে পারবেন");
    err.statusCode = 403;
    throw err;
  }
  return { schoolId: idxSnap.data().schoolId, isSuperAdmin: false };
}

module.exports = async function handler(req, res) {
  try {
    const decoded = await verifyRequestToken(req);
    const admin = getAdmin();
    const db = admin.firestore();
    const { schoolId } = await resolveSchoolId(db, decoded, req);
    const schoolRef = db.collection("schools").doc(schoolId);

    if (req.method === "GET") {
      const snap = await schoolRef.get();
      const googleSheetId = snap.exists ? snap.data().googleSheetId || null : null;
      const googleSheetTitle = snap.exists ? snap.data().googleSheetTitle || null : null;
      res.status(200).json({
        connected: !!googleSheetId,
        spreadsheetId: googleSheetId,
        spreadsheetTitle: googleSheetTitle,
        serviceAccountEmail: serviceAccountEmail(),
      });
      return;
    }

    if (req.method === "POST") {
      const raw = (req.body && req.body.spreadsheetId) || "";
      const spreadsheetId = extractSpreadsheetId(raw);
      if (!spreadsheetId) {
        res.status(400).json({ error: "সঠিক Google Sheet আইডি বা লিংক দিন" });
        return;
      }
      const info = await verifySpreadsheetAccess(spreadsheetId);
      await schoolRef.set(
        {
          googleSheetId: spreadsheetId,
          googleSheetTitle: info.title,
          googleSheetConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      res.status(200).json({ ok: true, spreadsheetId, spreadsheetTitle: info.title });
      return;
    }

    if (req.method === "DELETE") {
      await schoolRef.set(
        {
          googleSheetId: admin.firestore.FieldValue.delete(),
          googleSheetTitle: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "শুধু GET, POST, DELETE সমর্থিত" });
  } catch (e) {
    console.error("sheets-config এরর:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message || "সার্ভার এরর" });
  }
};
