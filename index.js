import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

/* ===============================
   APP SETUP
=============================== */
const app = express();

/* ===============================
   ENV SAFETY CHECK (CRITICAL)
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
   CORS (GLOBAL + SAFE)
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
   FIREBASE ADMIN (GUARDED)
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
   ROOT CHECK
=============================== */
app.get("/", (_, res) => {
  res.json({ status: "OK", service: "ElitePros Backend" });
});

/* ===============================
   CREATE PAYMENT (DEPOSIT)
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
      return res.status(502).json({ error: "Payment gateway error" });
    }

    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      amount: parsedAmount,
      status: "pending",
      gateway: "zapupi",
      utr: null,
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
app.post("/verify-payment", async (req, res) => {
  try {
    const { uid, orderId } = req.body;
    if (!uid || !orderId) {
      return res.status(400).json({ error: "Missing uid or orderId" });
    }

    const txnRef = db.ref(`users/${uid}/transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) return res.json({ status: "NOT_FOUND" });
    if (snap.val().status === "success") return res.json({ status: "SUCCESS" });

    const amount = Number(snap.val().amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(500).json({ error: "Invalid transaction amount" });
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

    await db.ref(`users/${uid}/wallet/deposited`)
      .transaction(v => (Number(v) || 0) + amount);

    await txnRef.update({
      status: "success",
      utr: zapupi.utr || null,
      completed_at: Date.now()
    });

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   JOIN MATCH (CRASH-PROOF)
=============================== */
app.post("/join-match", async (req, res) => {
  try {
    const { uid, matchId, ign } = req.body;
    if (!uid || !matchId || !ign) {
      return res.status(400).json({ error: "Missing data" });
    }

    const matchRef = db.ref(`matches/${matchId}`);
    const userRef = db.ref(`users/${uid}`);
    const playerRef = db.ref(`matches/${matchId}/players/${uid}`);

    let joinError = null;

    await matchRef.transaction(match => {
      if (!match) return match;
      if (!match.players) match.players = {};

      if (match.players[uid]) {
        joinError = "ALREADY_JOINED";
        return;
      }

      if ((match.joinedCount || 0) >= match.maxPlayers) {
        joinError = "MATCH_FULL";
        return;
      }

      match.joinedCount = (match.joinedCount || 0) + 1;
      return match;
    });

    if (joinError) {
      return res.status(409).json({ error: joinError });
    }

    const wallet = (await userRef.child("wallet").once("value")).val() || {};
    const entryFee =
      Number((await matchRef.child("entryFee").once("value")).val()) || 0;

    const deposited = Number(wallet.deposited || 0);
    const winnings = Number(wallet.winnings || 0);

    const depositUsed = Math.min(deposited, entryFee);
    const winningUsed = entryFee - depositUsed;

    if (depositUsed + winningUsed < entryFee) {
      return res.status(403).json({ error: "INSUFFICIENT_BALANCE" });
    }

    await userRef.child("wallet").update({
      deposited: deposited - depositUsed,
      winnings: winnings - winningUsed
    });

    await userRef.update({ ign });

    const username =
      (await userRef.child("username").once("value")).val() || "";

    await playerRef.set({
      uid,
      username,
      ign,
      depositUsed,
      winningUsed,
      joinedAt: Date.now()
    });

    const txnId = "TXN" + Date.now();
    await userRef.child(`transactions/${txnId}`).set({
      transactionId: txnId,
      type: "match_join",
      matchId,
      amount: -entryFee,
      depositUsed,
      winningUsed,
      status: "success",
      timestamp: Date.now()
    });

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("JOIN MATCH ERROR:", err);
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
