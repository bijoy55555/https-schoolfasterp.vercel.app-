// ===================================================================
// /api/payment — SSLCommerz-এর IPN (server-to-server) ও Redirect
// (success/fail/cancel, ব্রাউজার রিডাইরেক্ট) — দুটো ভিন্ন এন্ডপয়েন্ট
// এখন একই ফাইলে (sheets.js-এর প্যাটার্নেই, Vercel Hobby প্ল্যানের
// ১২-সার্ভারলেস-ফাংশন লিমিটের মধ্যে থাকার জন্য payment-ipn.js ও
// payment-redirect.js — এই দুটো ফাইলকে এখানে মার্জ করা হয়েছে)।
//
// ⚠️ পুরনো পাবলিক URL অপরিবর্তিত রাখা হয়েছে — vercel.json-এ rewrite
// যোগ করা হয়েছে, তাই নিচের কোনোটাই বদলানোর দরকার নেই:
//   • initiate-payment.js-এর success_url/fail_url/cancel_url
//     (এখনো /api/payment-redirect?status=... ব্যবহার করে)
//   • SSLCommerz মার্চেন্ট প্যানেলে সেট করা IPN URL
//     (এখনো /api/payment-ipn হলেই চলবে)
// vercel.json rewrite নিচের এই দুটো পুরনো পাথকে ?action= প্যারামিটার
// যোগ করে এই ফাইলে পাঠিয়ে দেয়:
//   /api/payment-ipn      → /api/payment?action=ipn
//   /api/payment-redirect → /api/payment?action=redirect
// ===================================================================
const axios = require("axios");
const { getAdmin, markFeePaidForPayment } = require("../lib/firebaseAdmin");

// SSLCommerz-এর নিজস্ব validationserverAPI-তে val_id দিয়ে সার্ভার-টু-সার্ভার
// re-verify করে — IPN এবং redirect দুটোতেই একই লজিক, তাই একটাই শেয়ার্ড হেল্পার
async function verifyWithSslcommerz(paymentSettings, valId) {
  if (!valId) return false;
  const IS_LIVE = !!paymentSettings.sslcommerzIsLive;
  const validationUrl = IS_LIVE
    ? "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
    : "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php";
  try {
    const resp = await axios.get(validationUrl, {
      params: {
        val_id: valId,
        store_id: paymentSettings.sslcommerzStoreId,
        store_passwd: paymentSettings.sslcommerzStorePassword,
        format: "json",
      },
      timeout: 15000,
    });
    return resp.data && (resp.data.status === "VALID" || resp.data.status === "VALIDATED");
  } catch (e) {
    console.error("payment: SSLCommerz validation কল ব্যর্থ:", e.message);
    return false;
  }
}

// ===================================================================
// action=ipn — SSLCommerz সার্ভার থেকে সরাসরি POST (ব্যবহারকারীর ব্রাউজার
// জড়িত না) — সবসময় "OK"/"IGNORED" টেক্সট রেসপন্স দিতে হয়, JSON না
// (আগে payment-ipn.js নামে আলাদা ফাইল ছিল, হুবহু একই লজিক)
// ===================================================================
async function handleIpn(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("শুধু POST সমর্থিত");
    return;
  }

  const { tran_id, val_id, status, value_a } = req.body || {};
  const schoolId = value_a;

  if (status !== "VALID" || !schoolId || !tran_id || !val_id) {
    res.status(200).send("IGNORED");
    return;
  }

  try {
    const admin = getAdmin();
    const db = admin.firestore();

    const paymentSettingsSnap = await db
      .collection("schools")
      .doc(schoolId)
      .collection("settings")
      .doc("payment")
      .get();
    const paymentSettings = paymentSettingsSnap.exists ? paymentSettingsSnap.data() : {};

    const verified = await verifyWithSslcommerz(paymentSettings, val_id);

    if (verified) {
      await db
        .collection("schools")
        .doc(schoolId)
        .collection("payments")
        .doc(tran_id)
        .set(
          {
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            verifiedByIpn: true,
          },
          { merge: true }
        );
      await markFeePaidForPayment(db, schoolId, tran_id);
    } else {
      console.warn("IPN এসেছে কিন্তু validation API-তে যাচাই ব্যর্থ হয়েছে:", tran_id);
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("IPN হ্যান্ডলার এরর:", e.message);
    res.status(200).send("ERROR_LOGGED");
  }
}

// ===================================================================
// action=redirect — SSLCommerz-এর success_url/fail_url/cancel_url,
// ব্যবহারকারীর ব্রাউজার থেকে রিডাইরেক্ট হয়ে আসে। status=success
// কুয়েরি-প্যারামিটার কখনো সরাসরি বিশ্বাস করা হয় না — val_id দিয়ে আবার
// server-to-server re-verify করেই status আপডেট হয়। শেষে সবসময় app.html-এ
// redirect করে দেয় (আগে payment-redirect.js নামে আলাদা ফাইল ছিল, হুবহু
// একই লজিক)
// ===================================================================
async function handleRedirect(req, res) {
  const statusLabel = req.query.status || "fail";
  const body = req.body || {};
  const tranId = body.tran_id || req.query.tran_id || "";
  const schoolId = body.value_a || req.query.value_a || "";
  const valId = body.val_id || req.query.val_id || "";

  if (schoolId && tranId) {
    try {
      const admin = getAdmin();
      const db = admin.firestore();
      const schoolRef = db.collection("schools").doc(schoolId);
      const paymentRef = schoolRef.collection("payments").doc(tranId);

      // আগের payment ডকুমেন্ট থাকা বাধ্যতামূলক (initiate-payment.js-এই তৈরি হয়) —
      // না থাকলে এই tran_id/schoolId জোড়া বানোয়াট, কিছুই করা হবে না
      const paySnap = await paymentRef.get();
      if (!paySnap.exists) {
        console.warn("payment-redirect: অজানা tran_id/schoolId — সম্ভাব্য ভুয়া রিকোয়েস্ট:", tranId, schoolId);
      } else if (paySnap.data().status === "paid") {
        // ইতিমধ্যে (IPN বা আগের রিকোয়েস্টে) পেইড হয়ে গেছে — ডাবল-প্রসেস করার দরকার নেই
      } else if (statusLabel === "success") {
        const paymentSettingsSnap = await schoolRef.collection("settings").doc("payment").get();
        const paymentSettings = paymentSettingsSnap.exists ? paymentSettingsSnap.data() : {};
        const verified = await verifyWithSslcommerz(paymentSettings, valId);

        if (verified) {
          await paymentRef.set(
            { status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp(), verifiedByRedirect: true },
            { merge: true }
          );
          await markFeePaidForPayment(db, schoolId, tranId);
        } else {
          console.warn("payment-redirect: val_id যাচাই ব্যর্থ, paid মার্ক করা হয়নি:", tranId);
          // যাচাই ব্যর্থ হলে "paid" করা হবে না — IPN পরে সঠিকভাবে এলে সেটাই আসল আপডেট করবে
        }
      } else {
        const newStatus = statusLabel === "fail" ? "failed" : "cancelled";
        await paymentRef.set({ status: newStatus }, { merge: true });
      }
    } catch (e) {
      console.error("redirect-এ Firestore আপডেট এরর:", e.message);
    }
  }

  let origin = process.env.APP_URL || `https://${req.headers.host}`;
  origin = origin.replace(/\/+$/, "");
  origin = origin.replace(/\/app\.html$/, "");
  const APP_URL = `${origin}/app.html`;
  res.redirect(
    302,
    `${APP_URL}?payment=${statusLabel}&tran_id=${encodeURIComponent(tranId)}&school_id=${encodeURIComponent(schoolId)}`
  );
}

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";

  if (action === "ipn") {
    await handleIpn(req, res);
    return;
  }
  if (action === "redirect") {
    await handleRedirect(req, res);
    return;
  }

  // সরাসরি /api/payment?action= ছাড়া হিট করলে (ভুল কনফিগারেশন বা ম্যানুয়াল টেস্ট)
  res.status(400).json({ error: "অজানা action — ?action=ipn অথবা ?action=redirect দিন" });
};
