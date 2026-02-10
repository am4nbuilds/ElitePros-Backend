import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

/* ===============================
   APP SETUP
=============================== */
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
    console.error(`❌ Missing ENV variable: ${key}`);
    process.exit(1);
  }
}

/* ===============================
   CORS (FIXED)
=============================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());

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
   ULID (NO DEPENDENCY)
=============================== */
function generateULID() {
  const time = Date.now().toString(36);
  const rand = cryptoRandom(10);
  return `${time}${rand}`.toUpperCase();
}

function cryptoRandom(len) {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
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

    const raw = await zapupiRes.text();
    let zapupi;
    try {
      zapupi = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Zapupi invalid response", raw });
    }

    if (zapupi.status !== "success") {
      return res.status(502).json({ error: "Zapupi error", zapupi });
    }

    await db.ref(`users/${req.uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    res.json({ order_id: orderId, payment_url: zapupi.payment_url });

  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   VERIFY PAYMENT
=============================== */
app.post("/verify-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const { orderId } = req.body;
    const txnRef = db.ref(`users/${req.uid}/transactions/${orderId}`);
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

    await db.ref(`users/${req.uid}/wallet/winnings`)
      .transaction(v => (Number(v) || 0) + amount);

    await txnRef.update({ status: "success" });
    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   REQUEST WITHDRAWAL
=============================== */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const walletRef = db.ref(`users/${req.uid}/wallet/winnings`);
    const snap = await walletRef.once("value");
    const winnings = Number(snap.val() || 0);

    if (amount > winnings) {
      return res.status(403).json({ error: "Insufficient winnings" });
    }

    const txnId = "WDR_" + generateULID();

    await walletRef.transaction(v => (Number(v) || 0) - amount);

    await db.ref(`users/${req.uid}/transactions/${txnId}`).set({
      transactionId: txnId,
      type: "withdrawal",
      amount,
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

/* ===============================
   ADMIN WITHDRAW ACTION
=============================== */
app.post("/admin/withdrawal-action",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId, transactionId, action, reason } = req.body;
      const txnRef = db.ref(`users/${userId}/transactions/${transactionId}`);
      const snap = await txnRef.once("value");

      if (!snap.exists()) return res.status(404).json({ error: "Not found" });
      if (snap.val().status !== "pending") {
        return res.status(400).json({ error: "Already processed" });
      }

      if (action === "approve") {
        await txnRef.update({ status: "success" });
        return res.json({ status: "APPROVED" });
      }

      if (action === "reject") {
        const refund = Number(snap.val().amount);
        await db.ref(`users/${userId}/wallet/winnings`)
          .transaction(v => (Number(v) || 0) + refund);

        await txnRef.update({
          status: "rejected",
          reason: reason || "Rejected by admin"
        });

        return res.json({ status: "REJECTED" });
      }

      res.status(400).json({ error: "Invalid action" });

    } catch (err) {
      console.error("ADMIN ERROR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* ===============================
   START SERVER
=============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
