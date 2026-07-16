const { getAdmin, markFeePaidForPayment } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
  const statusLabel = req.query.status || "fail";
  const body = req.body || {};
  const tranId = body.tran_id || req.query.tran_id || "";
  const schoolId = body.value_a || req.query.value_a || "";

  if (schoolId && tranId) {
    try {
      const admin = getAdmin();
      const db = admin.firestore();
      const newStatus =
        statusLabel === "success" ? "paid" : statusLabel === "fail" ? "failed" : "cancelled";

      await db
        .collection("schools")
        .doc(schoolId)
        .collection("payments")
        .doc(tranId)
        .set(
          {
            status: newStatus,
            ...(statusLabel === "success"
              ? { paidAt: admin.firestore.FieldValue.serverTimestamp() }
              : {}),
          },
          { merge: true }
        );

      if (statusLabel === "success") {
        await markFeePaidForPayment(db, schoolId, tranId);
      }
    } catch (e) {
      console.error("redirect-এ Firestore আপডেট এরর:", e.message);
    }
  }

  const APP_URL = process.env.APP_URL || `https://${req.headers.host}/app.html`;
  res.redirect(
    302,
    `${APP_URL}?payment=${statusLabel}&tran_id=${encodeURIComponent(tranId)}&school_id=${encodeURIComponent(schoolId)}`
  );
};
