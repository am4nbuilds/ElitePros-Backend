import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

/* ===============================
   APP SETUP
=============================== */
const app = express();

/* ===============================
   ENV SAFETY CHECK
=============================== */
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
    console.error(`❌ Missing ENV variable: ${key}`);
    process.exit(1);
  }
}

/* ===============================
   CORS
=============================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===============================
   FIREBASE ADMIN
=============================== */
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

/* ===============================
   AUTH MIDDLEWARE
=============================== */
async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===============================
   ROOT
=============================== */
app.get("/", (_, res) => {
  res.json({ status: "OK", service: "ElitePros Backend" });
});

/* ===============================
   CREATE PAYMENT (DEPOSIT)
=============================== */
app.post("/create-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const orderId = "ORD" + Date.now();
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

    const zapupiRes = await fetch("https://api.zapupi.com/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const zapupi = JSON.parse(await zapupiRes.text());
    if (zapupi.status !== "success") {
      return res.status(502).json({ error: "Payment gateway error" });
    }

    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    res.json({ order_id: orderId, payment_url: zapupi.payment_url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   VERIFY PAYMENT
=============================== */
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
    if (zapupi.status !== "success") return res.json({ status: "PENDING" });

    await db.ref(`users/${uid}/wallet/deposited`)
      .transaction(v => (Number(v) || 0) + amount);

    await txnRef.update({ status: "success" });
    res.json({ status: "SUCCESS" });

  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   REQUEST WITHDRAWAL (NEW)
=============================== */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const walletRef = db.ref(`users/${uid}/wallet`);
    const walletSnap = await walletRef.once("value");
    const winnings = Number(walletSnap.val()?.winnings || 0);

    if (amount > winnings) {
      return res.status(403).json({ error: "Insufficient winnings" });
    }

    const txnId = "WDR_" + Date.now();

    // 🔒 Deduct winnings immediately
    await walletRef.update({
      winnings: winnings - amount
    });

    // 📄 Create withdrawal transaction
    await db.ref(`users/${uid}/transactions/${txnId}`).set({
      transactionId: txnId,
      type: "withdrawal",
      amount: -amount,
      status: "pending",
      reason: "Withdrawal request",
      timestamp: Date.now()
    });

    res.json({ status: "PENDING", transactionId: txnId });

  } catch (err) {
    console.error("WITHDRAW ERROR:", err);
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
