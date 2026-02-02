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
if (
  !process.env.FB_PROJECT_ID ||
  !process.env.FB_CLIENT_EMAIL ||
  !process.env.FB_PRIVATE_KEY ||
  !process.env.FB_DB_URL
) {
  throw new Error("Missing Firebase environment variables");
}

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
   TEMP TEST UID
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
   CREATE PAYMENT
=============================== */
app.post("/create-payment", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!Number.isFinite(Number(amount)) || Number(amount) < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const orderId =
      "ORD" + Math.floor(100000000 + Math.random() * 900000000);

    const redirectUrl =
      "https://imaginative-lolly-654a8a.netlify.app/wallet.html?order_id=" +
      orderId;

    const body = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      amount: Number(amount).toString(),
      order_id: orderId,
      remark: "Wallet Deposit",
      redirect_url: redirectUrl
    });

    const response = await fetch(
      "https://api.zapupi.com/api/create-order",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }
    );

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Zapupi create-order non-JSON: " + text.slice(0, 150));
    }

    if (data.status !== "success") {
      return res.status(500).json({ error: "Zapupi order failed", data });
    }

    // ✅ STORE AMOUNT SAFELY IN DB (SOURCE OF TRUTH)
    await db.ref(`users/${TEST_UID}/transactions/${orderId}`).set({
      order_id: orderId,
      amount: Number(amount),
      status: "PENDING",
      created_at: Date.now()
    });

    res.json({
      order_id: orderId,
      payment_url: data.payment_url
    });

  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

/* ===============================
   VERIFY PAYMENT (SAFE)
=============================== */
app.post("/verify-payment", async (req, res) => {
  try {
    const orderId =
      req.body?.orderId ||
      req.body?.order_id ||
      req.query?.orderId ||
      req.query?.order_id;

    if (!orderId) {
      return res.json({ status: "IGNORED" });
    }

    // 🔥 READ AMOUNT FROM DB (NOT ZAPUPI)
    const txnRef = db.ref(`users/${TEST_UID}/transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.json({ status: "PENDING" });
    }

    const amount = Number(snap.val().amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Invalid amount in DB: " + snap.val().amount);
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
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }
    );

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Zapupi order-status non-JSON: " + text.slice(0, 150));
    }

    if (data.status !== "success") {
      return res.json({ status: "PENDING", zapupi: data });
    }

    await creditWalletAndUpdateTxn(
      TEST_UID,
      orderId,
      amount,
      data.txn_id,
      data.utr,
      "VERIFY_API"
    );

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

/* ===============================
   ZAPUPI WEBHOOK
=============================== */
app.post("/webhook/zapupi", async (req, res) => {
  try {
    const payload = req.body;

    if (payload.status !== "success") {
      return res.status(200).json({ message: "Ignored" });
    }

    const orderId = payload.order_id;

    const txnRef = db.ref(`users/${TEST_UID}/transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.status(200).json({ message: "Transaction not found" });
    }

    const amount = Number(snap.val().amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Invalid amount in DB");
    }

    await creditWalletAndUpdateTxn(
      TEST_UID,
      orderId,
      amount,
      payload.txn_id,
      payload.utr,
      "WEBHOOK"
    );

    res.status(200).json({ message: "Wallet credited" });

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

/* ===============================
   SHARED CREDIT FUNCTION
=============================== */
async function creditWalletAndUpdateTxn(
  uid,
  orderId,
  amount,
  txnId,
  utr,
  source
) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Attempted to credit invalid amount: " + amount);
  }

  const txnRef = db.ref(`users/${uid}/transactions/${orderId}`);
  const snap = await txnRef.once("value");

  if (snap.exists() && snap.val().status === "SUCCESS") {
    return;
  }

  await db.ref(`users/${uid}/wallet/deposited`)
    .transaction(v => (Number(v) || 0) + amount);

  await txnRef.update({
    status: "SUCCESS",
    amount,
    txn_id: txnId || null,
    utr: utr || null,
    source,
    completed_at: Date.now()
  });
}

/* ===============================
   START SERVER
=============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
