// ===================================================================
// lib/googleSheets.js — Google Sheets ইন্টিগ্রেশন হেল্পার
//
// ডিজাইন:
//   ✅ একটাই Google Cloud Service Account (env variable-এ রাখা) সব স্কুলের জন্য ব্যবহার হয়।
//   ✅ প্রতিটা স্কুল নিজের Google Sheet বানিয়ে সেই Sheet-টা এই Service Account-এর
//      ইমেইলের সাথে "Editor" হিসেবে শেয়ার করে, তারপর Sheet-এর আইডি ERP-তে বসায়
//      (দেখুন api/sheets-config.js) — সেটা Firestore-এ schools/{schoolId}.googleSheetId
//      ফিল্ডে সেভ থাকে।
//   ✅ কোন স্কুলের ডেটা কোন Sheet-এ যাবে সেটা সবসময় সার্ভার-সাইডে schoolId দিয়ে ঠিক হয়
//      (schoolId কখনো ক্লায়েন্ট থেকে বিশ্বাস করে নেওয়া হয় না — userIndex/{uid} থেকে বের
//      করা হয়, দেখুন api/devices.js-এর একই প্যাটার্ন) — তাই এক স্কুল অন্য স্কুলের Sheet-এ
//      ভুলবশত ডেটা লিখতে পারবে না।
//   ✅ আপনি (প্ল্যাটফর্মের মালিক) চাইলে যেকোনো স্কুলের Sheet-এ অ্যাক্সেস রাখতে পারবেন —
//      কারণ Service Account-টা আপনারই, এবং প্রতিটা স্কুল সেই একই ইমেইলকে Editor বানায়।
// ===================================================================
const { google } = require("googleapis");

let cachedClient = null;

function serviceAccountEmail() {
  return process.env.GOOGLE_SHEETS_CLIENT_EMAIL || "";
}

function getAuthClient() {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    const err = new Error(
      "GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env variable সেট করা নেই — Vercel Dashboard-এ এগুলো বসান।"
    );
    err.statusCode = 500;
    throw err;
  }
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    // spreadsheets: সিঙ্ক ফিচারের জন্য (নিজের কানেক্ট করা Sheet-এ লেখা)
    // drive.readonly: "প্রিন্ট" ফিচারের জন্য — যেকোনো স্কুল-অ্যাডমিনের
    // নিজের Google একাউন্টে বানানো Sheet, যেটা অন্তত "Anyone with the
    // link can view" করে শেয়ার করা আছে, সেটার PDF export পড়ার অনুমতি।
    // এতে সেই Sheet-টা আলাদা করে আমাদের Service Account-কে Editor
    // বানিয়ে দিতে হয় না — লিংক-শেয়ারিং থাকলেই যথেষ্ট।
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

function getSheetsClient() {
  if (cachedClient) return cachedClient;
  cachedClient = google.sheets({ version: "v4", auth: getAuthClient() });
  return cachedClient;
}

// ✅ "প্রিন্ট" ফিচার — docs.google.com-এর rich export URL (A4/মার্জিন/গ্রিডলাইন
// কাস্টমাইজেশন সহ) OAuth bearer token দিয়ে সার্ভার-সাইড থেকে কল করে PDF
// বাইট ফেরত দেয়। এতে ব্রাউজার কখনো docs.google.com-এ নেভিগেট করে না, তাই
// অ্যান্ড্রয়েডের "Google Sheets অ্যাপে খুলে যাওয়া" সমস্যা হয় না — PDF-টা
// সবসময় আমাদের নিজের ডোমেইন থেকেই আসে।
async function fetchExportPdf(spreadsheetId, extraParams) {
  const authClient = getAuthClient();
  const tokenResp = await authClient.authorize();
  const accessToken = tokenResp.access_token;

  const params = new URLSearchParams({
    format: "pdf",
    size: "A4",
    portrait: "true",
    fitw: "true",
    scale: "4",
    top_margin: "0.4",
    bottom_margin: "0.4",
    left_margin: "0.4",
    right_margin: "0.4",
    gridlines: "true",
    printtitle: "false",
    sheetnames: "false",
    pagenumbers: "false",
    horizontal_alignment: "CENTER",
    ...(extraParams || {}),
  });
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?${params.toString()}`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    const err = new Error(
      resp.status === 403 || resp.status === 401
        ? 'এই Sheet-টা পড়া যায়নি। Sheet খুলে "Share" বাটনে গিয়ে অন্তত "Anyone with the link — Viewer" করে দিন, তারপর আবার চেষ্টা করুন।'
        : `PDF তৈরি করা যায়নি (Google থেকে স্ট্যাটাস ${resp.status})`
    );
    err.statusCode = resp.status === 403 || resp.status === 401 ? 400 : 502;
    throw err;
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// URL বা খালি আইডি — দুটোই সমর্থন করে, যাতে ইউজার সরাসরি Google Sheet-এর লিংক পেস্ট করলেও কাজ করে
function extractSpreadsheetId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  return null;
}

async function getSchoolSpreadsheetId(db, schoolId) {
  const snap = await db.collection("schools").doc(schoolId).get();
  if (!snap.exists) return null;
  return snap.data().googleSheetId || null;
}

// নতুন করে কানেক্ট করার সময় যাচাই করে যে আসলেই Sheet-টায় এই Service Account-এর
// Editor অ্যাক্সেস আছে কিনা (নাহলে পরে সিঙ্কের সময় হুট করে এরর দেখাবে)
async function verifySpreadsheetAccess(spreadsheetId) {
  const sheets = getSheetsClient();
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties.title" });
    return { title: meta.data.properties.title, tabs: meta.data.sheets.map((s) => s.properties.title) };
  } catch (e) {
    const err = new Error(
      `এই Sheet-এ অ্যাক্সেস পাওয়া যায়নি। Sheet-টা Google Sheets-এ খুলে, "Share" বাটনে ক্লিক করে ` +
      `${serviceAccountEmail()} ইমেইলটাকে "Editor" হিসেবে যোগ করুন, তারপর আবার চেষ্টা করুন। (${e.message})`
    );
    err.statusCode = 400;
    throw err;
  }
}

async function ensureTab(sheets, spreadsheetId, tabName, headerRow) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
  // হেডার রো সবসময় প্রথম সারিতে ঠিক আছে কিনা নিশ্চিত করা হয় (idempotent)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headerRow] },
  });
}

// পুরনো ডেটা মুছে নতুন করে পুরো তালিকা বসিয়ে দেয় (students/fees-এর মতো "বর্তমান অবস্থা" টাইপ ডেটার জন্য)
async function overwriteTab(spreadsheetId, tabName, headerRow, rows) {
  const sheets = getSheetsClient();
  await ensureTab(sheets, spreadsheetId, tabName, headerRow);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A2:ZZ200000` });
  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A2`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  }
}

// নিচে নতুন সারি জুড়ে দেয় (attendance স্ক্যানের মতো "ইভেন্ট লগ" টাইপ ডেটার জন্য)
async function appendToTab(spreadsheetId, tabName, headerRow, rows) {
  const sheets = getSheetsClient();
  await ensureTab(sheets, spreadsheetId, tabName, headerRow);
  if (rows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  }
}

module.exports = {
  serviceAccountEmail,
  getSheetsClient,
  extractSpreadsheetId,
  getSchoolSpreadsheetId,
  verifySpreadsheetAccess,
  overwriteTab,
  appendToTab,
  fetchExportPdf,
};
