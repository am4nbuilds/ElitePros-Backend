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

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
  }),
  databaseURL: process.env.FB_DB_URL
});

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
    res.status(401).json({ error: "Invalid token" });
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
    if (!amount || amount < 1) return res.status(400).json({ error: "Invalid amount" });

    const orderId = "ORD" + Date.now();

    const redirectUrl =
      "https://testingwithme.infinityfree.me/wallet.html?order_id=" + orderId;

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
      return res.status(502).json({ error: "Gateway error" });

    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      type: "deposit",
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    res.json({ order_id: orderId, payment_url: zapupi.payment_url });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Create payment failed" });
  }
});

/* ======================================================
   VERIFY PAYMENT
====================================================== */
app.post("/verify-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { orderId } = req.body;

    const txnRef = db.ref(`users/${uid}/transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) return res.json({ status: "NOT_FOUND" });
    if (snap.val().status === "success") return res.json({ status: "SUCCESS" });

    const amount = Number(snap.val().amount);

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      order_id: orderId
    });

    const statusRes = await fetch("https://api.zapupi.com/api/order-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const zapupi = JSON.parse(await statusRes.text());

    if (zapupi.payment_status !== "SUCCESS")
      return res.json({ status: "PENDING" });

    // CREDIT ONLY DEPOSIT WALLET
    await db.ref(`users/${uid}/wallet/deposit`)
      .transaction(v => (Number(v)||0) + amount);

    await txnRef.update({ status: "success" });

    res.json({ status: "SUCCESS", amount });

  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "PENDING" });
  }
});

/* ======================================================
   REQUEST WITHDRAW
====================================================== */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);

    const ref = db.ref(`users/${uid}/wallet/winnings`);
    const snap = await ref.once("value");

    if (amount > (snap.val()||0))
      return res.status(403).json({ error: "Insufficient winnings" });

    const id = "WDR_" + Date.now();

    await ref.transaction(v => (Number(v)||0) - amount);

    await db.ref(`users/${uid}/withdrawals/${id}`).set({
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    res.json({ status: "PENDING", id });

  } catch {
    res.status(500).json({ error: "Withdraw failed" });
  }
});

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
