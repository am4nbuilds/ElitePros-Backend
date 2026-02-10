import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";
import { ulid } from "ulid";

const app = express();

/* ===============================
   ENV CHECK
=============================== */
[
  "FB_PROJECT_ID",
  "FB_CLIENT_EMAIL",
  "FB_PRIVATE_KEY",
  "FB_DB_URL",
  "ZAPUPI_API_KEY",
  "ZAPUPI_SECRET_KEY"
].forEach(k => {
  if (!process.env[k]) {
    console.error("Missing ENV:", k);
    process.exit(1);
  }
});

/* ===============================
   MIDDLEWARE
=============================== */
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json());

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
   AUTH
=============================== */
async function verifyFirebaseToken(req, res, next) {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const token = h.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

async function verifyAdmin(req, res, next) {
  const snap = await db.ref(`admins/${req.uid}`).once("value");
  if (snap.val() === true) return next();
  res.status(403).json({ error: "Admin only" });
}

/* ===============================
   ROOT
=============================== */
app.get("/", (_, res) => res.json({ status: "OK" }));

/* ===============================
   CREATE DEPOSIT (ZAPUPI)
=============================== */
app.post("/create-payment", verifyFirebaseToken, async (req, res) => {
  const uid = req.uid;
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const orderId = "DEP_" + ulid();

  const body = new URLSearchParams({
    token_key: process.env.ZAPUPI_API_KEY,
    secret_key: process.env.ZAPUPI_SECRET_KEY,
    amount: amount.toString(),
    order_id: orderId,
    remark: "Wallet Deposit",
    redirect_url: `https://imaginative-lolly-654a8a.netlify.app/wallet.html?order_id=${orderId}`
  });

  const r = await fetch("https://api.zapupi.com/api/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const z = JSON.parse(await r.text());
  if (z.status !== "success") return res.status(502).json({ error: "Zapupi failed" });

  await db.ref(`users/${uid}/transactions/${orderId}`).set({
    transactionId: orderId,
    type: "deposit",
    amount,
    status: "pending",
    timestamp: Date.now()
  });

  res.json({ order_id: orderId, payment_url: z.payment_url });
});

/* ===============================
   VERIFY DEPOSIT (IDEMPOTENT)
=============================== */
app.post("/verify-payment", verifyFirebaseToken, async (req, res) => {
  const uid = req.uid;
  const { orderId } = req.body;

  const txnRef = db.ref(`users/${uid}/transactions/${orderId}`);
  const snap = await txnRef.once("value");

  if (!snap.exists()) return res.json({ status: "NOT_FOUND" });
  if (snap.val().status === "success") {
    return res.json({ status: "SUCCESS" }); // 🔒 already credited
  }

  const body = new URLSearchParams({
    token_key: process.env.ZAPUPI_API_KEY,
    secret_key: process.env.ZAPUPI_SECRET_KEY,
    order_id: orderId
  });

  const r = await fetch("https://api.zapupi.com/api/order-status", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const z = JSON.parse(await r.text());
  if (z.status !== "success") return res.json({ status: "PENDING" });

  const amount = Number(snap.val().amount);

  await db.ref(`users/${uid}/wallet/winnings`)
    .transaction(v => (Number(v) || 0) + amount);

  await txnRef.update({ status: "success" });

  res.json({ status: "SUCCESS" });
});

/* ===============================
   USER WITHDRAW REQUEST
=============================== */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  const uid = req.uid;
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const walletRef = db.ref(`users/${uid}/wallet/winnings`);
  const snap = await walletRef.once("value");
  const winnings = Number(snap.val() || 0);
  if (amount > winnings) {
    return res.status(403).json({ error: "Insufficient winnings" });
  }

  const txnId = "WDR_" + ulid();

  await walletRef.transaction(v => (Number(v) || 0) - amount);

  await db.ref(`users/${uid}/transactions/${txnId}`).set({
    transactionId: txnId,
    type: "withdrawal",
    amount,
    status: "pending",
    reason: "Withdrawal requested",
    timestamp: Date.now()
  });

  res.json({ status: "PENDING", transactionId: txnId });
});

/* ===============================
   ADMIN WITHDRAW ACTION
=============================== */
app.post("/admin/withdrawal-action",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {

    const { userId, transactionId, action, reason } = req.body;
    const txnRef = db.ref(`users/${userId}/transactions/${transactionId}`);
    const snap = await txnRef.once("value");
    if (!snap.exists()) return res.status(404).json({ error: "Not found" });

    const txn = snap.val();
    if (txn.status !== "pending") {
      return res.status(400).json({ error: "Already processed" });
    }

    if (action === "approve") {
      await txnRef.update({ status: "success" });
      return res.json({ status: "APPROVED" });
    }

    if (action === "reject") {
      await db.ref(`users/${userId}/wallet/winnings`)
        .transaction(v => (Number(v) || 0) + Number(txn.amount));

      await txnRef.update({
        status: "rejected",
        reason: reason || "Rejected by admin"
      });

      return res.json({ status: "REJECTED" });
    }

    res.status(400).json({ error: "Invalid action" });
  }
);

/* ===============================
   START
=============================== */
app.listen(process.env.PORT || 3000, () =>
  console.log("Backend running")
);
