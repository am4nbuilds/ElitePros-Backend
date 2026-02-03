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
      return res.status(500).json({ error: "Zapupi failed" });
    }

    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      reason: "Wallet Deposit",
      amount: parsedAmount,
      status: "pending",
      gateway: "zapupi",
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
      throw new Error("Invalid amount");
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
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   JOIN MATCH (PRODUCTION SAFE)
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

    // 🔒 Atomic match lock (prevents race + double join)
    await matchRef.transaction(match => {
      if (!match) return match;
      if (!match.players) match.players = {};
      if (match.players[uid]) throw new Error("ALREADY_JOINED");
      if ((match.joinedCount || 0) >= match.maxPlayers) {
        throw new Error("MATCH_FULL");
      }
      match.joinedCount = (match.joinedCount || 0) + 1;
      return match;
    });

    // 💰 Wallet calculation
    const wallet = (await userRef.child("wallet").once("value")).val() || {};
    const entryFee =
      Number((await matchRef.child("entryFee").once("value")).val()) || 0;

    const deposited = Number(wallet.deposited || 0);
    const winnings = Number(wallet.winnings || 0);

    let depositUsed = Math.min(deposited, entryFee);
    let winningUsed = entryFee - depositUsed;

    if (depositUsed + winningUsed < entryFee) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    // 🔐 Deduct wallet
    await userRef.child("wallet").update({
      deposited: deposited - depositUsed,
      winnings: winnings - winningUsed
    });

    // 🧠 Save IGN for future joins
    await userRef.update({ ign });

    // 🎮 Save player info
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

    // 💳 Create transaction (USER-SCOPED)
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
    console.error("JOIN MATCH ERROR:", err.message);

    if (err.message === "ALREADY_JOINED") {
      return res.status(409).json({ error: "Already joined" });
    }
    if (err.message === "MATCH_FULL") {
      return res.status(409).json({ error: "Match full" });
    }
    if (err.message === "INSUFFICIENT_BALANCE") {
      return res.status(403).json({ error: "Insufficient balance" });
    }

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
