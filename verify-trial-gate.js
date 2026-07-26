// ===================================================================
// /api/verify-trial-gate — ফ্রি ট্রায়াল শুরুর আগে পাসওয়ার্ড সার্ভার-সাইডে যাচাই
//
// কেন এই এন্ডপয়েন্ট: আগে পাসওয়ার্ডটা ব্রাউজারের JS কোডেই লেখা ছিল, তাই যেকোনো
// টেকনিক্যাল ভিজিটর "View Source"/Inspect করে সেটা দেখে ফেলতে পারতো। এখন পাসওয়ার্ড
// শুধু সার্ভারে (Environment Variable) থাকে — ব্রাউজারের কোনো ফাইলে এটা লেখা নেই।
//
// সেটআপ (Vercel Dashboard):
//   Project → Settings → Environment Variables →
//   Name: TRIAL_GATE_PASSWORD   Value: 585858   (অথবা আপনার পছন্দের নতুন পাসওয়ার্ড)
//   → Save → পরের ডিপ্লয়মেন্ট থেকে কার্যকর হবে
//
// ⚠️ সিকিউরিটি ফিক্স: আগে TRIAL_GATE_PASSWORD সেট না থাকলে একটা হার্ডকোডেড ডিফল্ট
// ('585858') ব্যবহার হতো — আর সেই ডিফল্টটা এই ফাইলের কমেন্টেই (যা GitHub-এ পাবলিক)
// লেখা ছিল। কেউ Vercel-এ env variable সেট করতে ভুলে গেলে পুরো গেটটাই কার্যত পাবলিক
// হয়ে যেত। এখন env variable সেট না থাকলে এই এন্ডপয়েন্ট fail-closed থাকে (সবসময়
// 500 দেবে, কোনো পাসওয়ার্ডই কাজ করবে না) — আপনাকে অবশ্যই Vercel Dashboard-এ নিজের
// পাসওয়ার্ড সেট করতে হবে, নাহলে ট্রায়াল গেট খুলবেই না।
//
// Body (JSON): { "password": "আপনার-সেট-করা-পাসওয়ার্ড" }
// Response:    { "ok": true }  অথবা  { "ok": false, "error": "..." }
// ===================================================================

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "শুধু POST সমর্থিত" });
    return;
  }

  try {
    const { password } = req.body || {};
    const correctPassword = process.env.TRIAL_GATE_PASSWORD;

    if (!correctPassword) {
      console.error("verify-trial-gate: TRIAL_GATE_PASSWORD env variable সেট করা নেই — গেট বন্ধ রাখা হলো।");
      res.status(500).json({
        ok: false,
        error: "সার্ভারে ট্রায়াল-গেট পাসওয়ার্ড সেটআপ করা নেই — অ্যাডমিনিস্ট্রেটরকে জানান।",
      });
      return;
    }

    if (!password || typeof password !== "string") {
      res.status(400).json({ ok: false, error: "পাসওয়ার্ড দিন" });
      return;
    }

    // সাধারণ টাইমিং-অ্যাটাক এড়াতে সাথে সাথে উত্তর না দিয়ে সামান্য বিলম্ব
    await new Promise((r) => setTimeout(r, 300));

    if (password.trim() === correctPassword) {
      res.status(200).json({ ok: true });
    } else {
      res.status(401).json({ ok: false, error: "পাসওয়ার্ড ভুল" });
    }
  } catch (e) {
    console.error("verify-trial-gate এরর:", e.message);
    res.status(500).json({ ok: false, error: "সার্ভার এরর" });
  }
};
