import express from "express";
import cors from "cors";
import admin from "firebase-admin";

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

    // Zapupi-safe order id
    const orderId =
      "ORD" + Math.floor(100000000 + Math.random() * 900000000);

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      amount: amount.toString(),
      order_id: orderId,
      remark: "Wallet Deposit",

      // 🔥 RETURN URL (IMPORTANT)
      redirect_url:
  encodeURIComponent(
    "https://imaginative-lolly-654a8a.netlify.app/wallet.html?order_id=" + orderId
  )
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

    // Save pending transaction
    await db.ref(`users/${TEST_UID}/transactions/${orderId}`).set({
      order_id: orderId,
      amount,
      status: "PENDING",
      created_at: Date.now()
    });

    // Send payment URL to frontend
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
   VERIFY PAYMENT (THIS UPDATES WALLET)
=============================== */
app.post("/verify-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    // Ask Zapupi for order status
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

    // Not paid yet
    if (data.status !== "success") {
      return res.json({ status: "PENDING" });
    }

    const txnRef =
      db.ref(`users/${TEST_UID}/transactions/${orderId}`);

    const snap = await txnRef.once("value");

    // 🛑 Prevent double credit
    if (snap.exists() && snap.val().status === "SUCCESS") {
      return res.json({ status: "ALREADY_VERIFIED" });
    }

    // ✅ Update wallet
    await db.ref(`users/${TEST_UID}/wallet/deposited`)
      .transaction(v => (v || 0) + Number(data.amount));

    // ✅ Update transaction
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
   START SERVER
=============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
