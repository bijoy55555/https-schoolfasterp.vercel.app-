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
// Environment Variable সেট না থাকলে ডিফল্ট হিসেবে '585858' ব্যবহার হবে (যাতে সেটআপ
// ছাড়াই কাজ করে), তবে প্রকৃত নিরাপত্তার জন্য Vercel-এ নিজের পাসওয়ার্ড সেট করা উচিত —
// তাহলে সেটা কোনো কোডেই লেখা থাকবে না, শুধু Vercel-এর সিক্রেট স্টোরেজে থাকবে।
//
// Body (JSON): { "password": "585858" }
// Response:    { "ok": true }  অথবা  { "ok": false, "error": "..." }
// ===================================================================

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "শুধু POST সমর্থিত" });
    return;
  }

  try {
    const { password } = req.body || {};
    const correctPassword = process.env.TRIAL_GATE_PASSWORD || "585858";

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
