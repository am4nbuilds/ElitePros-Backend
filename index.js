import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

const app = express();

/* ===============================
   ENV CHECK
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
    console.error(`Missing ENV variable: ${key}`);
    process.exit(1);
  }
}

/* ===============================
   MIDDLEWARE
=============================== */
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===============================
   FIREBASE ADMIN INIT
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
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* ===============================
   ADMIN CHECK
=============================== */
async function verifyAdmin(req, res, next) {
  try {
    const snap = await db.ref(`admins/${req.uid}`).once("value");
    if (snap.val() === true) return next();
    return res.status(403).json({ error: "Admin only" });
  } catch {
    return res.status(403).json({ error: "Admin only" });
  }
}

/* ===============================
   ROOT
=============================== */
app.get("/", (_, res) => {
  res.json({ status: "OK", service: "ElitePros Backend" });
});

/* =========================================================
   REQUEST WITHDRAWAL (NOW STORES UPI ID)
========================================================= */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);
    const upiId = String(req.body.upiId || "").trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // UPI VALIDATION
    const upiRegex = /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/;
    if (!upiRegex.test(upiId)) {
      return res.status(400).json({ error: "Invalid UPI ID" });
    }

    const walletRef = db.ref(`users/${uid}/wallet/winnings`);
    const snap = await walletRef.once("value");
    const winnings = Number(snap.val() || 0);

    if (amount > winnings) {
      return res.status(403).json({ error: "Insufficient winnings" });
    }

    const txnId = "WDR_" + Date.now();

    // Deduct winnings safely
    await walletRef.transaction(v => (Number(v) || 0) - amount);

    // Store transaction with UPI ID
    await db.ref(`users/${uid}/transactions/${txnId}`).set({
      transactionId: txnId,
      type: "withdrawal",
      amount,
      upiId,
      status: "pending",
      reason: "Withdrawal requested",
      timestamp: Date.now()
    });

    res.json({ status: "PENDING", transactionId: txnId });

  } catch (err) {
    console.error("WITHDRAW ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ADMIN APPROVE / REJECT WITHDRAWAL (UPDATED)
========================================================= */
app.post("/admin/withdrawal-action", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { userId, transactionId, action, reason, upiReference } = req.body;

    const txnRef = db.ref(`users/${userId}/transactions/${transactionId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const txn = snap.val();

    if (txn.status !== "pending") {
      return res.status(400).json({ error: "Already processed" });
    }

    if (action === "approve") {

      if (!upiReference || upiReference.length < 5) {
        return res.status(400).json({ error: "UPI reference required" });
      }

      await txnRef.update({
        status: "success",
        upiReference,
        approvedAt: Date.now(),
        approvedBy: req.uid
      });

      return res.json({ status: "APPROVED" });
    }

    if (action === "reject") {
      const refundAmount = Number(txn.amount);

      await db.ref(`users/${userId}/wallet/winnings`)
        .transaction(v => (Number(v) || 0) + refundAmount);

      await txnRef.update({
        status: "rejected",
        reason: reason || "Rejected by admin",
        rejectedAt: Date.now(),
        rejectedBy: req.uid
      });

      return res.json({ status: "REJECTED" });
    }

    return res.status(400).json({ error: "Invalid action" });

  } catch (err) {
    console.error("ADMIN WITHDRAW ERROR:", err);
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
