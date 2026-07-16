// ===================================================================
// /api/zkteco-adms — ZKTeco ফেস/ফিঙ্গারপ্রিন্ট ডিভাইসের নিজস্ব ADMS/Push
// প্রোটোকল হ্যান্ডেল করে (uFace, SpeedFace, MB-সিরিজ, iFace ইত্যাদি মডেলে
// "Comm → Cloud Server Setting"-এ যে সার্ভার ঠিকানা বসানো হয়, ডিভাইস নিজে
// থেকেই /iclock/cdata, /iclock/getrequest ইত্যাদি ফিক্সড পাথে রিকোয়েস্ট পাঠায়
// — এই পাথগুলো vercel.json rewrite দিয়ে এখানে আনা হয়েছে)।
//
// ডিভাইস আমাদের কাস্টম JSON ফরম্যাট বোঝে না — তাই এই ফাইলটা ZKTeco-র নিজস্ব
// টেক্সট প্রোটোকল পার্স করে, এনরোল করা ইউজারের PIN (ডিভাইসের ইউজার আইডি)-কে
// rfidMap-এর uid হিসেবে ব্যবহার করে একই resolveAndMarkAttendance() লজিক কল করে।
//
// ⚠️ ZKTeco ডিভাইস সবসময় HTTP 200 + "OK" আশা করে, নাহলে বারবার রিট্রাই করে বা
// লগ জমিয়ে রাখে — তাই এখানে কোনো এরর হলেও 200 + OK দিয়েই সাড়া দেওয়া হয়েছে,
// আসল এরর শুধু সার্ভার লগে (console.error) থাকে।
// ===================================================================
const { getAdmin } = require("../lib/firebaseAdmin");
const { resolveAndMarkAttendance } = require("../lib/biometricAttendance");

// Vercel-এর ডিফল্ট bodyParser শুধু JSON বোঝে — ZKTeco ATTLOG ডেটা পাঠায় প্লেইন
// ট্যাব-সেপারেটেড টেক্সট হিসেবে, তাই bodyParser বন্ধ করে নিজে raw body পড়া হচ্ছে।
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "text/plain");
  const sn = (req.query && req.query.SN) || "";
  const table = (req.query && req.query.table) || "";
  const path = (req.url || "").split("?")[0];

  try {
    // ডিভাইস কমান্ড পোল করার সময় (getrequest) বা কমান্ড-রেজাল্ট পাঠানোর সময় (devicecmd)
    // — আমরা কোনো রিমোট কমান্ড পাঠাই না, তাই সবসময় "OK" (কোনো পেন্ডিং কমান্ড নেই)
    if (path.endsWith("/getrequest") || path.endsWith("/devicecmd") || path.endsWith("/registry")) {
      await readRawBody(req).catch(() => {});
      res.status(200).send("OK");
      return;
    }

    if (!sn) {
      res.status(200).send("OK");
      return;
    }

    const admin = getAdmin();
    const db = admin.firestore();

    // SN দিয়ে কোন স্কুলের কোন ডিভাইস — এই লুকআপ devices.js রেজিস্ট্রেশনের সময় লেখা হয়
    const lookupSnap = await db.collection("zktecoDevices").doc(String(sn)).get();
    if (!lookupSnap.exists) {
      console.warn("অচেনা ZKTeco SN (রেজিস্টার করা নেই):", sn);
      res.status(200).send("OK");
      return;
    }
    const { schoolId, deviceId } = lookupSnap.data();

    // ধাপ ১: ডিভাইস প্রথমবার কানেক্ট করলে (options=all) কনফিগারেশন চায়
    if (req.method === "GET" && !table) {
      res.status(200).send(
        [
          `GET OPTION FROM: ${sn}`,
          "Stamp=9999",
          "OpStamp=9999",
          "ErrorDelay=60",
          "Delay=30",
          "TransFlag=TransData AttLog OpLog",
          "TransTimes=00:00;23:59",
          "Realtime=1",
          "Encrypt=0",
        ].join("\n")
      );
      return;
    }

    // ধাপ ২: হার্টবিট / অন্য টেবিল সিঙ্ক রিকোয়েস্ট (ATTLOG ছাড়া অন্য কিছু) — শুধু OK
    if (req.method === "GET" && table) {
      res.status(200).send("OK");
      return;
    }

    // ধাপ ৩: আসল হাজিরা ডেটা — প্রতিটা লাইন: PIN\tসময়\tস্ট্যাটাস\tভেরিফাই\tওয়ার্ককোড...
    if (req.method === "POST" && table === "ATTLOG") {
      const raw = await readRawBody(req);
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      let ok = 0;
      for (const line of lines) {
        const parts = line.split("\t");
        const pin = parts[0];
        const time = parts[1]; // ফরম্যাট: "YYYY-MM-DD HH:MM:SS" (ডিভাইসের নিজের ঘড়ি অনুযায়ী)
        if (!pin) continue;
        try {
          await resolveAndMarkAttendance(admin, db, schoolId, {
            uid: String(pin),
            ts: time,
            source: "zkteco",
            deviceId,
          });
          ok++;
        } catch (e) {
          // একটা PIN আনম্যাপড হলেও বাকি লাইনগুলো প্রসেস চলতে থাকবে
          console.warn(`ZKTeco PIN "${pin}" স্কিপ:`, e.message);
        }
      }
      await db
        .collection("schools")
        .doc(schoolId)
        .collection("devices")
        .doc(deviceId)
        .set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log(`ZKTeco ATTLOG: ${ok}/${lines.length} স্ক্যান প্রসেস হয়েছে (SN=${sn})`);
      res.status(200).send("OK");
      return;
    }

    // অন্য যেকোনো POST (OPERLOG, USERINFO, FACE ডেটা সিঙ্ক ইত্যাদি) — গ্রহণ করে নিলাম, প্রয়োজন নেই
    await readRawBody(req).catch(() => {});
    res.status(200).send("OK");
  } catch (e) {
    console.error("zkteco-adms এরর:", e.message);
    res.status(200).send("OK");
  }
};

// Vercel serverless function config — bodyParser বন্ধ, কারণ raw text body নিজে পড়া হচ্ছে (উপরে দেখুন)
module.exports.config = { api: { bodyParser: false } };
