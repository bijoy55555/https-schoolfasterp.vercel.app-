// ===================================================================
// /api/sheets-sync — স্কুলের ডেটা (ছাত্র/ফি/হাজিরা) কানেক্ট করা Google Sheet-এ পাঠায়
//   POST { types?: ["students","fees","attendance"] } → না দিলে তিনটাই সিঙ্ক হবে
//
// schoolId সবসময় লগইন করা ইউজারের userIndex/{uid} থেকে বের করা হয় (কখনো request
// body থেকে না), তাই এই এন্ডপয়েন্ট দিয়ে কোনো স্কুল ভুলেও অন্য স্কুলের Sheet-এ ডেটা
// পাঠাতে পারবে না — প্রতিটা স্কুলের ডেটা শুধু তার নিজের কানেক্ট করা Sheet-এই যায়।
//
// Students/Fees ট্যাব প্রতিবার পুরো ওভাররাইট হয় (সবসময় "বর্তমান অবস্থা" দেখায়),
// আর Attendance Logs ট্যাবে শুধু গত সিঙ্কের পর নতুন যা স্ক্যান হয়েছে তা যোগ (append) হয়,
// যাতে বারবার সিঙ্ক করলেও Sheet-এ ডুপ্লিকেট সারি না জমে।
// ===================================================================
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");
const { getSchoolSpreadsheetId, overwriteTab, appendToTab } = require("../lib/googleSheets");

async function resolveSchoolId(db, decoded) {
  const idxSnap = await db.collection("userIndex").doc(decoded.uid).get();
  if (!idxSnap.exists || !idxSnap.data().schoolId) {
    const err = new Error("এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই");
    err.statusCode = 403;
    throw err;
  }
  if (idxSnap.data().role !== "admin") {
    const err = new Error("শুধু স্কুল-অ্যাডমিন সিঙ্ক করতে পারবেন");
    err.statusCode = 403;
    throw err;
  }
  return idxSnap.data().schoolId;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "শুধু POST সমর্থিত" });
    return;
  }
  try {
    const decoded = await verifyRequestToken(req);
    const admin = getAdmin();
    const db = admin.firestore();
    const schoolId = await resolveSchoolId(db, decoded);
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
  } catch (e) {
    console.error("sheets-sync এরর:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message || "সার্ভার এরর" });
  }
};
