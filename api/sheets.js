// ===================================================================
// /api/sheets — Google Sheets কানেকশন + সিঙ্ক, একই ফাইলে (Vercel Hobby
// প্ল্যানের ১২-সার্ভারলেস-ফাংশন লিমিটের মধ্যে থাকার জন্য আগের
// sheets-config.js ও sheets-sync.js — এই দুইটা ফাইল এখানে একসাথে করা
// হয়েছে। রুট আলাদা হয় query প্যারামিটার ?action= দিয়ে:
//
//   GET    /api/sheets?action=status   → কানেকশন স্ট্যাটাস দেখায়
//   POST   /api/sheets?action=connect  → { spreadsheetId } দিয়ে কানেক্ট করে
//   DELETE /api/sheets?action=connect  → কানেকশন বিচ্ছিন্ন করে
//   POST   /api/sheets?action=sync     → { types? } দিয়ে ডেটা সিঙ্ক করে
//
// schoolId কখনো request body থেকে বিশ্বাস করে নেওয়া হয় না — সবসময় লগইন
// করা ইউজারের userIndex/{uid} থেকে বের করা হয় (api/devices.js-এর মতো
// একই প্যাটার্ন), তাই কোনো স্কুল-অ্যাডমিন অন্য স্কুলের Sheet
// কানেক্ট/দেখা/মোছা/সিঙ্ক — কিছুই করতে পারবে না।
// ===================================================================
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");
const {
  serviceAccountEmail,
  extractSpreadsheetId,
  verifySpreadsheetAccess,
  getSchoolSpreadsheetId,
  overwriteTab,
  appendToTab,
} = require("../lib/googleSheets");

async function resolveSchoolId(db, decoded, req, { allowSuperAdminQuery } = {}) {
  if (allowSuperAdminQuery) {
    const saSnap = await db.collection("superAdmins").doc(decoded.uid).get();
    if (saSnap.exists) {
      const requested = (req.query && req.query.schoolId) || (req.body && req.body.schoolId);
      if (!requested) {
        const err = new Error("সুপার-অ্যাডমিন হিসেবে schoolId (query/body-তে) দিতে হবে");
        err.statusCode = 400;
        throw err;
      }
      return requested;
    }
  }
  const idxSnap = await db.collection("userIndex").doc(decoded.uid).get();
  if (!idxSnap.exists || !idxSnap.data().schoolId) {
    const err = new Error("এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই");
    err.statusCode = 403;
    throw err;
  }
  if (idxSnap.data().role !== "admin") {
    const err = new Error("শুধু স্কুল-অ্যাডমিন এই কাজ করতে পারবেন");
    err.statusCode = 403;
    throw err;
  }
  return idxSnap.data().schoolId;
}

async function handleStatus(db, schoolId, res) {
  const snap = await db.collection("schools").doc(schoolId).get();
  const googleSheetId = snap.exists ? snap.data().googleSheetId || null : null;
  const googleSheetTitle = snap.exists ? snap.data().googleSheetTitle || null : null;
  res.status(200).json({
    connected: !!googleSheetId,
    spreadsheetId: googleSheetId,
    spreadsheetTitle: googleSheetTitle,
    serviceAccountEmail: serviceAccountEmail(),
  });
}

async function handleConnect(admin, db, schoolId, req, res) {
  const raw = (req.body && req.body.spreadsheetId) || "";
  const spreadsheetId = extractSpreadsheetId(raw);
  if (!spreadsheetId) {
    res.status(400).json({ error: "সঠিক Google Sheet আইডি বা লিংক দিন" });
    return;
  }
  const info = await verifySpreadsheetAccess(spreadsheetId);
  await db.collection("schools").doc(schoolId).set(
    {
      googleSheetId: spreadsheetId,
      googleSheetTitle: info.title,
      googleSheetConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  res.status(200).json({ ok: true, spreadsheetId, spreadsheetTitle: info.title });
}

async function handleDisconnect(admin, db, schoolId, res) {
  await db.collection("schools").doc(schoolId).set(
    {
      googleSheetId: admin.firestore.FieldValue.delete(),
      googleSheetTitle: admin.firestore.FieldValue.delete(),
    },
    { merge: true }
  );
  res.status(200).json({ ok: true });
}

async function handleSync(admin, db, schoolId, req, res) {
  const schoolRef = db.collection("schools").doc(schoolId);
  const spreadsheetId = await getSchoolSpreadsheetId(db, schoolId);
  if (!spreadsheetId) {
    const err = new Error('আগে কোনো Google Sheet কানেক্ট করা হয়নি — "গুগল শিট" মডিউলে গিয়ে প্রথমে কানেক্ট করুন');
    err.statusCode = 400;
    throw err;
  }

  const requested = (req.body && req.body.types) || null;
  const wanted = Array.isArray(requested) && requested.length ? requested : ["students", "fees", "attendance"];
  const summary = {};

  if (wanted.includes("students")) {
    const snap = await db.collection("schools").doc(schoolId).collection("students").get();
    const rows = snap.docs.map((d) => {
      const s = d.data();
      return [s.roll || "", s.name || "", s.cls || "", s.section || "", s.guardian || "", s.phone || "", s.admissionDate || "", s.feeStatus || ""];
    });
    await overwriteTab(spreadsheetId, "Students", ["রোল", "নাম", "শ্রেণি", "শাখা", "অভিভাবক", "ফোন", "ভর্তির তারিখ", "ফি স্ট্যাটাস"], rows);
    summary.students = rows.length;
  }

  if (wanted.includes("fees")) {
    const snap = await db.collection("schools").doc(schoolId).collection("fees").get();
    const rows = snap.docs.map((d) => {
      const f = d.data();
      return [f.student || "", f.cls || "", f.type || "", f.amount || 0, f.date || "", f.method || "", f.status || ""];
    });
    await overwriteTab(spreadsheetId, "Fees", ["ছাত্র", "শ্রেণি", "ফি-এর ধরন", "পরিমাণ", "তারিখ", "মেথড", "স্ট্যাটাস"], rows);
    summary.fees = rows.length;
  }

  if (wanted.includes("attendance")) {
    const schoolSnap = await schoolRef.get();
    const lastSyncedAt = schoolSnap.exists ? schoolSnap.data().sheetAttendanceSyncedAt || null : null;
    let q = db.collection("schools").doc(schoolId).collection("attendanceLogs").orderBy("receivedAt", "asc");
    if (lastSyncedAt) q = q.where("receivedAt", ">", lastSyncedAt);
    const snap = await q.limit(2000).get();
    const rows = snap.docs.map((d) => {
      const l = d.data();
      return [l.dateKey || "", l.studentName || "", l.cls || "", l.status || "", l.source || "", l.deviceId || "", l.scanTs || ""];
    });
    if (rows.length) {
      await appendToTab(spreadsheetId, "Attendance Logs", ["তারিখ", "ছাত্র", "শ্রেণি", "স্ট্যাটাস", "সোর্স", "ডিভাইস আইডি", "স্ক্যানের সময়"], rows);
      const newest = snap.docs[snap.docs.length - 1].data().receivedAt;
      await schoolRef.set({ sheetAttendanceSyncedAt: newest }, { merge: true });
    }
    summary.attendance = rows.length;
  }

  await schoolRef.set({ sheetLastSyncedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  res.status(200).json({ ok: true, synced: summary });
}

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "status";
  try {
    const decoded = await verifyRequestToken(req);
    const admin = getAdmin();
    const db = admin.firestore();

    if (action === "status") {
      if (req.method !== "GET") return res.status(405).json({ error: "শুধু GET সমর্থিত" });
      const schoolId = await resolveSchoolId(db, decoded, req, { allowSuperAdminQuery: true });
      return await handleStatus(db, schoolId, res);
    }

    if (action === "connect") {
      const schoolId = await resolveSchoolId(db, decoded, req, { allowSuperAdminQuery: true });
      if (req.method === "POST") return await handleConnect(admin, db, schoolId, req, res);
      if (req.method === "DELETE") return await handleDisconnect(admin, db, schoolId, res);
      return res.status(405).json({ error: "শুধু POST/DELETE সমর্থিত" });
    }

    if (action === "sync") {
      if (req.method !== "POST") return res.status(405).json({ error: "শুধু POST সমর্থিত" });
      const schoolId = await resolveSchoolId(db, decoded, req, { allowSuperAdminQuery: false });
      return await handleSync(admin, db, schoolId, req, res);
    }

    res.status(400).json({ error: "অজানা action — status/connect/sync ব্যবহার করুন" });
  } catch (e) {
    console.error("sheets API এরর:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message || "সার্ভার এরর" });
  }
};
