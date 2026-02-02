import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

/* ===============================
   APP SETUP
=============================== */
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

/* ===============================
   FIREBASE ADMIN (SAFE)
=============================== */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
  }),
  databaseURL: process.env.FB_DB_URL
});

const db = admin.database();

/* ===============================
   TEMP TEST UID (REMOVE LATER)
=============================== */
const TEST_UID = "kNABqZe4O7Pj1UuagQ7n3887zB62";

/* ===============================
   ROOT CHECK
=============================== */
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "ElitePros Backend",
    time: new Date().toISOString()
  });
});

/* ===============================
   CREATE PAYMENT (ZAPUPI)
=============================== */
app.post("/create-payment", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const orderId =
      "ORD" + Math.floor(100000000 + Math.random() * 900000000);

    const redirectUrl =
      "https://imaginative-lolly-654a8a.netlify.app/wallet.html?order_id=" + orderId;

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      amount: amount.toString(),
      order_id: orderId,
      remark: "Wallet Deposit",
      redirect_url: redirectUrl
    });

    const response = await fetch(
      "https://api.zapupi.com/api/create-order",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const data = await response.json();

    if (data.status !== "success") {
      return res.status(500).json({
        error: "Zapupi order failed",
        zapupi: data
      });
    }

    await db.ref(`users/${TEST_UID}/transactions/${orderId}`).set({
      order_id: orderId,
      amount,
      status: "PENDING",
      created_at: Date.now()
    });

    res.json({
      order_id: orderId,
      payment_url: data.payment_url
    });

  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   VERIFY PAYMENT
=============================== */
app.post("/verify-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      order_id: orderId
    });

    const response = await fetch(
      "https://api.zapupi.com/api/order-status",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const data = await response.json();

    if (data.status !== "success") {
      return res.json({ status: "PENDING" });
    }

    const txnRef =
      db.ref(`users/${TEST_UID}/transactions/${orderId}`);

    const snap = await txnRef.once("value");

    if (snap.exists() && snap.val().status === "SUCCESS") {
      return res.json({ status: "ALREADY_VERIFIED" });
    }

    await db.ref(`users/${TEST_UID}/wallet/deposited`)
      .transaction(v => (v || 0) + Number(data.amount));

    await txnRef.update({
      status: "SUCCESS",
      amount: data.amount,
      utr: data.utr,
      txn_id: data.txn_id,
      verified_at: Date.now()
    });

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});
/* ===============================
   ZAPUPI WEBHOOK
=============================== */
app.post("/webhook/zapupi", async (req, res) => {
  try {
    const payload = req.body;

    console.log("Zapupi Webhook:", payload);

    /*
      Expected Zapupi payload (typical):
      {
        status: "success",
        order_id: "ORD123",
        amount: "10",
        utr: "1234567890",
        txn_id: "TXN123456"
      }
    */

    if (payload.status !== "success") {
      return res.status(200).json({ message: "Ignored (not success)" });
    }

    const orderId = payload.order_id;
    const amount = Number(payload.amount);
    const txnId = payload.txn_id || payload.utr;

    if (!orderId || !amount || !txnId) {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }

    // ⚠️ TEMP: HARDCODED UID (REMOVE LATER)
    const uid = "kNABqZe4O7Pj1UuagQ7n3887zB62";

    const txnRef = db.ref(`users/${uid}/transactions/${txnId}`);
    const snap = await txnRef.once("value");

    // 🛑 Prevent double credit
    if (snap.exists()) {
      return res.status(200).json({ message: "Already processed" });
    }

    // ✅ Update wallet (atomic)
    await db.ref(`users/${uid}/wallet/deposited`)
      .transaction(v => (v || 0) + amount);

    // ✅ Create transaction record
    await txnRef.set({
      txnid: txnId,
      order_id: orderId,
      amount: amount,
      utr: payload.utr || null,
      status: "SUCCESS",
      source: "ZAPUPI_WEBHOOK",
      created_at: Date.now()
    });

    return res.status(200).json({ message: "Wallet updated" });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});
/* ===============================
   START SERVER
=============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
