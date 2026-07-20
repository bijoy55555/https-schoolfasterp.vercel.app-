// ===================================================================
// POST /api/send-sms
// ===================================================================
// আগে app.html-এর SMS ফাংশনগুলো শুধু সিমুলেটেড ছিল (আসল SMS পাঠাতো না)।
// এখন এটা BulkSMSBD.net (https://bulksmsbd.net) এর API দিয়ে আসল SMS পাঠায়।
//
// ⚠️ এটা কাজ করার জন্য Vercel Dashboard → Project → Settings →
// Environment Variables-এ নিচের ভ্যারিয়েবলগুলো বসাতে হবে:
//
//   BULKSMSBD_API_KEY    = fudaeFpdFKlbypmSr7DW   (Developers পেজ থেকে কপি করা)
//   BULKSMSBD_SENDER_ID  = 09617                  (Non Masking sender — SMS Rates
//                            পেজে যেটা "Active" দেখাচ্ছে সেটাই বসান)
//
// এনভায়রনমেন্ট ভ্যারিয়েবল বদলানোর পর Vercel-এ আবার Deploy করতে হবে
// (Redeploy করলেই নতুন ভ্যারিয়েবল কাজ করবে)।
// ===================================================================
const axios = require("axios");
const { verifyRequestToken } = require("../lib/firebaseAdmin");

const BULKSMSBD_URL = "http://bulksmsbd.net/api/smsapi";

// bulksmsbd.net-এর ডকুমেন্টেশন অনুযায়ী এরর কোডের বাংলা ব্যাখ্যা
const ERROR_MEANING = {
  1001: "নম্বরটি সঠিক না (Invalid Number)",
  1002: "Sender ID সঠিক না বা বন্ধ আছে",
  1003: "কিছু তথ্য অনুপস্থিত — অ্যাডমিনের সাথে যোগাযোগ করুন",
  1005: "সার্ভারের নিজস্ব সমস্যা (Internal Error) — একটু পরে চেষ্টা করুন",
  1006: "ব্যালেন্সের মেয়াদ শেষ",
  1007: "ব্যালেন্স নেই — BulkSMSBD থেকে রিচার্জ করুন",
  1011: "ইউজার আইডি পাওয়া যায়নি",
  1012: "Masking নম্বর দিয়ে শুধু বাংলা মেসেজ পাঠানো যায়",
  1013: "এই Sender ID-এর জন্য কোনো Gateway পাওয়া যায়নি",
  1014: "এই Sender Type নামটি পাওয়া যায়নি",
  1015: "এই Sender ID-এর জন্য কোনো বৈধ Gateway নেই",
  1016: "এই Sender ID-এর জন্য অ্যাক্টিভ রেট পাওয়া যায়নি",
};

// বাংলাদেশি মোবাইল নম্বর ক্লিন ও যাচাই করা (01XXXXXXXXX ফরম্যাটে আনা)
function normalizeNumber(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[^\d]/g, "");
  if (n.startsWith("880")) n = n.slice(3);
  if (n.startsWith("0")) n = n;
  else if (n.length === 10) n = "0" + n;
  if (!/^01[3-9]\d{8}$/.test(n)) return null;
  return n;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "শুধু POST মেথড সমর্থিত" });
    return;
  }

  try {
    // লগইন যাচাই — শুধু স্কুলের লগইন করা ইউজারই SMS পাঠাতে পারবে
    await verifyRequestToken(req);

    const apiKey = process.env.BULKSMSBD_API_KEY;
    const senderId = process.env.BULKSMSBD_SENDER_ID || "09617";
    if (!apiKey) {
      throw Object.assign(
        new Error(
          "BULKSMSBD_API_KEY env variable সেট করা নেই — Vercel Dashboard-এ বসান।"
        ),
        { statusCode: 500 }
      );
    }

    const { numbers, message } = req.body || {};
    if (!message || !String(message).trim()) {
      throw Object.assign(new Error("বার্তা লিখুন"), { statusCode: 400 });
    }
    if (!Array.isArray(numbers) || numbers.length === 0) {
      throw Object.assign(new Error("অন্তত একজন প্রাপক দরকার"), {
        statusCode: 400,
      });
    }

    const valid = [];
    const invalid = [];
    numbers.forEach((n) => {
      const clean = normalizeNumber(n);
      if (clean) valid.push(clean);
      else invalid.push(n);
    });

    if (valid.length === 0) {
      throw Object.assign(
        new Error("কোনো বৈধ মোবাইল নম্বর পাওয়া যায়নি (01XXXXXXXXX ফরম্যাট দরকার)"),
        { statusCode: 400 }
      );
    }

    // bulksmsbd একই মেসেজ একাধিক নম্বরে পাঠাতে কমা-সেপারেটেড নম্বর সাপোর্ট করে
    const resp = await axios.get(BULKSMSBD_URL, {
      params: {
        api_key: apiKey,
        type: "text",
        number: valid.join(","),
        senderid: senderId,
        message: message,
      },
      timeout: 15000,
    });

    const raw = resp.data;
    const raw_str = typeof raw === "string" ? raw : JSON.stringify(raw);
    const codeMatch = raw_str.match(/\d{3,4}/);
    const code = codeMatch ? parseInt(codeMatch[0], 10) : null;

    if (code === 202) {
      res.status(200).json({
        ok: true,
        sentCount: valid.length,
        failed: invalid,
        raw: raw_str,
      });
    } else {
      const meaning = ERROR_MEANING[code] || raw_str;
      res.status(200).json({
        ok: false,
        error: `BulkSMSBD এরর (${code || "অজানা"}): ${meaning}`,
        raw: raw_str,
      });
    }
  } catch (e) {
    console.error("send-sms এরর:", e.message);
    res
      .status(e.statusCode || 500)
      .json({ ok: false, error: e.message || "SMS পাঠানো যায়নি" });
  }
};
