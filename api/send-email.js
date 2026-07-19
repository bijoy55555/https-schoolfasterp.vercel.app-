// ===================================================================
// POST /api/send-email
// ===================================================================
// প্ল্যাটফর্মের নিজস্ব শেয়ার্ড Resend অ্যাকাউন্ট দিয়ে ইমেইল পাঠায় —
// প্রতিটা স্কুলের অ্যাডমিনকে আলাদা করে কোনো API Key/সার্ভিস সেটআপ করতে
// হয় না, শুধু ফর্ম পূরণ করে "পাঠান" চাপলেই হয়।
//
// প্রতিটা স্কুলের জন্য প্যাকেজ (Trial/Basic/Standard/Premium) অনুযায়ী
// একটা মাসিক ইমেইল-কোটা প্রয়োগ করা হয় (schools/{schoolId}/usage/email-YYYY-MM
// ডকুমেন্টে গোনা হয়), যাতে একটা স্কুল বেশি পাঠিয়ে সবার শেয়ার্ড
// সেন্ডার-রেপুটেশন নষ্ট করতে না পারে।
//
// ⚠️ এটা কাজ করার জন্য প্রয়োজন:
//   ১) Vercel Dashboard-এ RESEND_API_KEY env variable সেট থাকতে হবে
//      (resend.com-এ ফ্রি অ্যাকাউন্ট খুলে ড্যাশবোর্ড থেকে কপি করা যায়)
//   ২) (ঐচ্ছিক) RESEND_FROM_EMAIL env variable — নিজের ভেরিফাইড ডোমেইন
//      থাকলে সেটা বসান, নাহলে ডিফল্ট onboarding@resend.dev ব্যবহার হবে
// ===================================================================
const axios = require("axios");
const { getAdmin, verifyRequestToken } = require("../lib/firebaseAdmin");

// ⚙️ প্যাকেজ অনুযায়ী মাসিক ইমেইল লিমিট — ব্যবসায়িক প্রয়োজন অনুযায়ী বদলে নিন
const PLAN_MONTHLY_LIMIT = {
  Trial: 20,
  Basic: 100,
  Standard: 300,
  Premium: 1000,
};

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "শুধু POST মেথড সমর্থিত" });
    return;
  }

  try {
    if (!process.env.RESEND_API_KEY) {
      throw new Error(
        "RESEND_API_KEY env variable সেট করা নেই — Vercel Dashboard-এ বসান।"
      );
    }

    const decoded = await verifyRequestToken(req);
    const admin = getAdmin();
    const db = admin.firestore();

    const idxSnap = await db.collection("userIndex").doc(decoded.uid).get();
    if (!idxSnap.exists || !idxSnap.data().schoolId) {
      res.status(403).json({ error: "এই ইউজারের সাথে কোনো স্কুল যুক্ত নেই" });
      return;
    }
    const schoolId = idxSnap.data().schoolId;

    const { subject, body, recipients } = req.body || {};
    if (!subject || !body) {
      res.status(400).json({ error: "subject ও body দেওয়া বাধ্যতামূলক" });
      return;
    }

    const cleanRecipients = Array.isArray(recipients)
      ? [...new Set(recipients.map((r) => String(r || "").trim()).filter(Boolean))]
      : [];
    if (cleanRecipients.length === 0) {
      res.status(400).json({ error: "অন্তত একটা বৈধ প্রাপকের ইমেইল ঠিকানা দিতে হবে" });
      return;
    }
    const invalid = cleanRecipients.filter((e) => !EMAIL_REGEX.test(e));
    if (invalid.length > 0) {
      res.status(400).json({ error: `এই ঠিকানাগুলো সঠিক ফরম্যাটে নেই: ${invalid.join(", ")}` });
      return;
    }
    if (cleanRecipients.length > 200) {
      res.status(400).json({ error: "একবারে সর্বোচ্চ ২০০ জনকে পাঠানো যাবে" });
      return;
    }

    const schoolSnap = await db.collection("schools").doc(schoolId).get();
    const school = schoolSnap.exists ? schoolSnap.data() : {};
    const pkg = school.package || "Trial";
    const limit = PLAN_MONTHLY_LIMIT[pkg] ?? PLAN_MONTHLY_LIMIT.Trial;

    const usageRef = db
      .collection("schools")
      .doc(schoolId)
      .collection("usage")
      .doc(`email-${currentMonthKey()}`);

    // ✅ ট্রানজেকশন দিয়ে কোটা চেক + বাড়ানো — একই সাথে দুইটা রিকোয়েস্ট এলেও
    // কোটা হিসাব ঠিক থাকবে (রেস কন্ডিশন এড়াতে)
    let newUsedCount = 0;
    await db.runTransaction(async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const used = usageSnap.exists ? usageSnap.data().count || 0 : 0;
      if (used + cleanRecipients.length > limit) {
        const err = new Error(
          `মাসিক ইমেইল কোটা শেষ (${pkg} প্যাকেজে মাসে ${limit}টা পর্যন্ত)। ` +
            `এই মাসে ইতিমধ্যে ${used}টা পাঠানো হয়েছে, বাকি আছে ${Math.max(0, limit - used)}টা। ` +
            `বেশি পাঠাতে চাইলে প্যাকেজ আপগ্রেড করুন।`
        );
        err.statusCode = 429;
        throw err;
      }
      newUsedCount = used + cleanRecipients.length;
      tx.set(
        usageRef,
        { count: newUsedCount, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    });

    // রিপ্লাই করলে যেন সরাসরি স্কুলের নিজের অ্যাডমিনের কাছে যায়, প্ল্যাটফর্মের কাছে না
    const replyTo = decoded.email || school.contactEmail || undefined;
    const fromName = school.name || "স্কুল ERP";

    // প্রাইভেসির জন্য (প্রাপক একে অপরের ইমেইল না দেখুক) প্রতিটাকে আলাদা করে পাঠানো হচ্ছে
    const results = await Promise.allSettled(
      cleanRecipients.map((to) =>
        axios.post(
          "https://api.resend.com/emails",
          {
            from: `${fromName} <${FROM_EMAIL}>`,
            to,
            reply_to: replyTo,
            subject,
            text: body,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        )
      )
    );

    const failed = results
      .map((r, i) => (r.status === "rejected" ? cleanRecipients[i] : null))
      .filter(Boolean);
    const sentCount = cleanRecipients.length - failed.length;

    res.status(200).json({
      ok: true,
      sentCount,
      failed,
      quota: { plan: pkg, limit, used: newUsedCount, remaining: Math.max(0, limit - newUsedCount) },
    });
  } catch (e) {
    console.error("send-email API এরর:", e.message);
    res.status(e.statusCode || 500).json({ error: e.message || "সার্ভার এরর" });
  }
};
