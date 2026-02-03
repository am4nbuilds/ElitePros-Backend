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
app.use(express.urlencoded({ extended: true }));

/* ===============================
   FIREBASE ADMIN
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
   ROOT CHECK
=============================== */
app.get("/", (_, res) => {
  res.json({ status: "OK", service: "ElitePros Backend" });
});

/* ===============================
   CREATE PAYMENT
=============================== */
app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount } = req.body;
    const parsedAmount = Number(amount);

    if (!uid || !Number.isFinite(parsedAmount) || parsedAmount < 1) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const orderId = "ORD" + Date.now();

    const redirectUrl =
      "https://imaginative-lolly-654a8a.netlify.app/wallet.html?order_id=" +
      orderId;

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      amount: parsedAmount.toString(),
      order_id: orderId,
      remark: "Wallet Deposit",
      redirect_url: redirectUrl
    });

    const zapupiRes = await fetch(
      "https://api.zapupi.com/api/create-order",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }
    );

    const zapupi = JSON.parse(await zapupiRes.text());

    if (zapupi.status !== "success") {
      return res.status(500).json({ error: "Zapupi failed" });
    }

    /* ===============================
       CREATE USER TRANSACTION (PENDING)
    =============================== */
    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      reason: "Wallet Deposit",
      amount: parsedAmount,
      status: "pending",
      gateway: "zapupi",
      utr: null,
      timestamp: Date.now()
    });

    res.json({
      order_id: orderId,
      payment_url: zapupi.payment_url
    });

  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   VERIFY PAYMENT (SETTLEMENT)
=============================== */
app.post("/verify-payment", async (req, res) => {
  try {
    const { uid, orderId } = req.body;

    if (!uid || !orderId) {
      return res.status(400).json({ error: "Missing uid or orderId" });
    }

    const txnRef = db.ref(`users/${uid}/transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.json({ status: "NOT_FOUND" });
    }

    if (snap.val().status === "success") {
      return res.json({ status: "SUCCESS" });
    }

    const amount = Number(snap.val().amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Invalid amount in transaction");
    }

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      order_id: orderId
    });

    const statusRes = await fetch(
      "https://api.zapupi.com/api/order-status",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }
    );

    const zapupi = JSON.parse(await statusRes.text());

    if (zapupi.status !== "success") {
      return res.json({ status: "PENDING" });
    }

    /* ===============================
       CREDIT WALLET (ATOMIC)
    =============================== */
    await db.ref(`users/${uid}/wallet/deposited`)
      .transaction(v => (Number(v) || 0) + amount);

    /* ===============================
       UPDATE TRANSACTION
    =============================== */
    await txnRef.update({
      status: "success",
      utr: zapupi.utr || null,
      completed_at: Date.now()
    });

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   START SERVER
=============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
