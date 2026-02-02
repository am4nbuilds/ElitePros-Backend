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
    const { amount, uid } = req.body;

    // 🔒 VALIDATION
    if (!uid) {
      return res.status(400).json({ error: "Missing uid" });
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
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
      amount: parsedAmount.toString(),
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
      throw new Error("Zapupi create-order non-JSON");
    }

    if (data.status !== "success") {
      return res.status(500).json({ error: "Zapupi order failed" });
    }

    // 🔐 STORE ORDER (SOURCE OF TRUTH)
    await db.ref(`transactions/${orderId}`).set({
      uid,
      amount: parsedAmount,
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
   VERIFY PAYMENT (PRIMARY)
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

    // 🔐 READ FROM DB ONLY
    const txnRef = db.ref(`transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.json({ status: "PENDING" });
    }

    const { uid, amount, status } = snap.val();

    if (status === "SUCCESS") {
      return res.json({ status: "SUCCESS" });
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error("Invalid amount in DB");
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
      throw new Error("Zapupi order-status non-JSON");
    }

    if (data.status !== "success") {
      return res.json({ status: "PENDING" });
    }

    await creditWallet(uid, orderId, parsedAmount, data.txn_id, data.utr);

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   ZAPUPI WEBHOOK (SECONDARY)
=============================== */
app.post("/webhook/zapupi", async (req, res) => {
  try {
    const payload = req.body;

    if (payload.status !== "success") {
      return res.status(200).json({ message: "Ignored" });
    }

    const orderId = payload.order_id;
    if (!orderId) {
      return res.status(200).json({ message: "Missing orderId" });
    }

    const txnRef = db.ref(`transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.status(200).json({ message: "Unknown order" });
    }

    const { uid, amount, status } = snap.val();

    if (status === "SUCCESS") {
      return res.status(200).json({ message: "Already processed" });
    }

    await creditWallet(uid, orderId, Number(amount), payload.txn_id, payload.utr);

    res.status(200).json({ message: "Wallet credited" });

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   WALLET CREDIT (ATOMIC)
=============================== */
async function creditWallet(uid, orderId, amount, txnId, utr) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid credit amount");
  }

  const userWalletRef = db.ref(`users/${uid}/wallet/deposited`);
  const txnRef = db.ref(`transactions/${orderId}`);

  await userWalletRef.transaction(v => (Number(v) || 0) + amount);

  await txnRef.update({
    status: "SUCCESS",
    txn_id: txnId || null,
    utr: utr || null,
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
