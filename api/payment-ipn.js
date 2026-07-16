const axios = require("axios");
const { getAdmin, markFeePaidForPayment } = require("../lib/firebaseAdmin");

module.exports = async function handler(req, res) {
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
    const STORE_ID = paymentSettings.sslcommerzStoreId;
    const STORE_PASSWORD = paymentSettings.sslcommerzStorePassword;
    const IS_LIVE = !!paymentSettings.sslcommerzIsLive;

    const validationUrl = IS_LIVE
      ? "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
      : "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php";

    const verifyResp = await axios.get(validationUrl, {
      params: {
        val_id,
        store_id: STORE_ID,
        store_passwd: STORE_PASSWORD,
        format: "json",
      },
    });

    const verified =
      verifyResp.data &&
      (verifyResp.data.status === "VALID" || verifyResp.data.status === "VALIDATED");

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
};
