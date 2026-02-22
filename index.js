import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

const app = express();

/* ================= ENV ================= */
const REQUIRED_ENV = [
  "FB_PROJECT_ID",
  "FB_CLIENT_EMAIL",
  "FB_PRIVATE_KEY",
  "FB_DB_URL",
  "ZAPUPI_API_KEY",
  "ZAPUPI_SECRET_KEY"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing ENV variable: ${key}`);
    process.exit(1);
  }
}

/* ================= MIDDLEWARE ================= */
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= FIREBASE ================= */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
    }),
    databaseURL: process.env.FB_DB_URL
  });
}

const db = admin.database();

/* ================= AUTH ================= */
async function verifyFirebaseToken(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ================= ROOT ================= */
app.get("/", (_, res) => res.json({ status: "OK" }));

/* ======================================================
   CREATE PAYMENT
====================================================== */
app.post("/create-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount < 1)
      return res.status(400).json({ error: "Invalid amount" });

    const orderId = "ORD" + Date.now();

    const redirectUrl =
      "https://testingwithme.infinityfree.me/wallet.html";

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      amount: amount.toString(),
      order_id: orderId,
      remark: "Wallet Deposit",
      redirect_url: redirectUrl
    });

    const zapupiRes = await fetch("https://api.zapupi.com/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const zapupi = JSON.parse(await zapupiRes.text());

    if (zapupi.status !== "success")
      return res.status(502).json({ error: "Gateway error", zapupi });

    /* Save transaction */
    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    /* Save order mapping */
    await db.ref(`orders/${orderId}`).set({
      uid,
      amount,
      status: "pending",
      createdAt: Date.now()
    });

    res.json({ order_id: orderId, payment_url: zapupi.payment_url });

  } catch (e) {
    console.error("CREATE PAYMENT ERROR:", e);
    res.status(500).json({ error: "Create payment failed" });
  }
});

/* ======================================================
   🔥 ZAPUPI WEBHOOK (ONLY PAYMENT CONFIRMATION SOURCE)
====================================================== */
app.post("/zapupi-webhook", async (req, res) => {
  try {
    console.log("🔥 Webhook hit:", req.body);

    const { order_id, payment_status } = req.body;

    if (!order_id || payment_status !== "SUCCESS")
      return res.status(200).send("Ignored");

    const orderSnap = await db.ref(`orders/${order_id}`).once("value");

    if (!orderSnap.exists())
      return res.status(404).send("Order not found");

    const { uid, amount, status } = orderSnap.val();

    if (status === "success")
      return res.status(200).send("Already processed");

    const txnRef = db.ref(`users/${uid}/transactions/${order_id}`);
    const txnSnap = await txnRef.once("value");

    if (!txnSnap.exists())
      return res.status(404).send("Transaction missing");

    if (txnSnap.val().status === "success")
      return res.status(200).send("Already credited");

    /* Credit wallet safely */
    await db.ref(`users/${uid}/wallet/deposited`)
      .transaction(v => (Number(v) || 0) + Number(amount));

    /* Update transaction */
    await txnRef.update({
      status: "success",
      confirmedAt: Date.now()
    });

    /* Update order */
    await db.ref(`orders/${order_id}`).update({
      status: "success",
      confirmedAt: Date.now()
    });

    console.log("✅ Payment credited:", order_id);

    return res.status(200).send("OK");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).send("Error");
  }
});

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
