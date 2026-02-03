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
       CREATE TRANSACTION (DESIGN-FIRST)
    =============================== */
    await db.ref(`transactions/${uid}/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      reason: "Wallet Deposit",
      amount: parsedAmount,            // positive = credit
      status: "pending",
      gateway: "zapupi",
      source: "upi",
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
   VERIFY PAYMENT
=============================== */
app.post("/verify-payment", async (req, res) => {
  try {
    const orderId =
      req.body?.orderId ||
      req.query?.order_id;

    if (!orderId) return res.json({ status: "IGNORED" });

    // 🔎 Find transaction by scanning users later if needed
    // For now we assume wallet page sends correct uid later

    return res.json({ status: "PENDING" });

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
