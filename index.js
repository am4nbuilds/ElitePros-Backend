import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();

/* ================= ENV CHECK ================= */
const REQUIRED_ENV = [
  "FB_PROJECT_ID",
  "FB_CLIENT_EMAIL",
  "FB_PRIVATE_KEY",
  "FB_DB_URL"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing ENV variable: ${key}`);
    process.exit(1);
  }
}

/* ================= MIDDLEWARE ================= */
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"] }));
app.use(express.json());

/* ================= FIREBASE ================= */
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

/* ================= AUTH ================= */
async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).json({ error: "Unauthorized" });

    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ================= ADMIN CHECK ================= */
async function verifyAdmin(req, res, next) {
  const snap = await db.ref(`admins/${req.uid}`).once("value");
  if (snap.val() === true) return next();
  return res.status(403).json({ error: "Admin only" });
}

/* ================= ROOT ================= */
app.get("/", (_, res) => res.json({ status: "OK" }));

/* =========================================================
   USER REQUEST WITHDRAWAL
========================================================= */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);
    const upiId = String(req.body.upiId || "");

    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "Invalid amount" });

    const walletRef = db.ref(`users/${uid}/wallet/winnings`);

    const result = await walletRef.transaction(current => {
      current = Number(current || 0);
      if (current < amount) return; // abort
      return current - amount;
    });

    if (!result.committed)
      return res.status(403).json({ error: "Insufficient winnings" });

    const txnId = "WDR_" + Date.now() + "_" + Math.floor(Math.random()*9999);

    const txnData = {
      transactionId: txnId,
      type: "withdrawal",
      amount,
      upiId,
      status: "pending",
      reason: "Awaiting admin approval",
      timestamp: Date.now()
    };

    const updates = {};
    updates[`users/${uid}/transactions/${txnId}`] = txnData;
    updates[`users/${uid}/withdrawals/${txnId}`] = txnData;

    await db.ref().update(updates);

    res.json({ status: "PENDING", transactionId: txnId });

  } catch (err) {
    console.error("WITHDRAW ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ADMIN APPROVE / REJECT
========================================================= */
app.post("/admin/withdrawal-action", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { userId, transactionId, action, reason } = req.body;

    const txnRef = db.ref(`users/${userId}/withdrawals/${transactionId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists())
      return res.status(404).json({ error: "Transaction not found" });

    const txn = snap.val();

    if (txn.status !== "pending")
      return res.status(400).json({ error: "Already processed" });

    if (action === "approve") {

      await db.ref().update({
        [`users/${userId}/withdrawals/${transactionId}/status`]: "success",
        [`users/${userId}/transactions/${transactionId}/status`]: "success",
        [`users/${userId}/withdrawals/${transactionId}/reason`]: "Paid successfully",
        [`users/${userId}/transactions/${transactionId}/reason`]: "Paid successfully"
      });

      return res.json({ status: "APPROVED" });
    }

    if (action === "reject") {

      const refund = Number(txn.amount || 0);

      await db.ref(`users/${userId}/wallet/winnings`)
        .transaction(v => (Number(v)||0)+refund);

      await db.ref().update({
        [`users/${userId}/withdrawals/${transactionId}/status`]: "rejected",
        [`users/${userId}/transactions/${transactionId}/status`]: "rejected",
        [`users/${userId}/withdrawals/${transactionId}/reason`]: reason || "Rejected by admin",
        [`users/${userId}/transactions/${transactionId}/reason`]: reason || "Rejected by admin"
      });

      return res.json({ status: "REJECTED" });
    }

    res.status(400).json({ error: "Invalid action" });

  } catch (err) {
    console.error("ADMIN ACTION ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on", PORT));
