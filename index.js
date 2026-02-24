import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

const app = express();

/* ================= ENV ================= */
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

/* ================= MIDDLEWARE ================= */
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ================= ROOT ================= */
app.get("/", (_, res) => res.json({ status: "OK" }));

/* ======================================================
   CREATE PAYMENT
====================================================== */
app.post("/create-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount < 1)
      return res.status(400).json({ error: "Invalid amount" });

    const orderId = "ORD" + Date.now();

    const redirectUrl =
      "https://testingwithme.infinityfree.me/wallet.html";

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

    if (zapupi.status !== "success")
      return res.status(502).json({ error: "Gateway error" });

    await db.ref(`users/${uid}/transactions/${orderId}`).set({
      transactionId: orderId,
      type: "deposit",
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    await db.ref(`orders/${orderId}`).set({
      uid,
      amount,
      status: "pending",
      locked: false,
      createdAt: Date.now()
    });

    res.json({ order_id: orderId, payment_url: zapupi.payment_url });

  } catch (e) {
    console.error("CREATE PAYMENT ERROR:", e);
    res.status(500).json({ error: "Create payment failed" });
  }
});

/* ======================================================
   🔐 SECURE WEBHOOK (PROPER VERIFICATION)
====================================================== */
app.post("/zapupi-webhook", async (req, res) => {
  try {
    console.log("Webhook hit:", req.body);

    const { order_id } = req.body;
    if (!order_id) return res.status(400).send("Invalid webhook");

    const orderRef = db.ref(`orders/${order_id}`);

    /* LOCK ORDER */
    const lockResult = await orderRef.transaction(order => {
      if (!order) return order;
      if (order.status === "success") return order;
      if (order.locked === true) return;
      order.locked = true;
      return order;
    });

    if (!lockResult.committed)
      return res.status(200).send("Already processing");

    const order = lockResult.snapshot.val();
    if (!order) return res.status(404).send("Order not found");

    if (order.status === "success")
      return res.status(200).send("Already processed");

    const { uid, amount: storedAmount } = order;

    /* VERIFY WITH ZAPUPI SERVER-SIDE */
    const verifyBody = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      order_id
    });

    const verifyRes = await fetch("https://api.zapupi.com/api/order-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: verifyBody.toString()
    });

    const zapupi = JSON.parse(await verifyRes.text());

    console.log("Gateway verify response:", zapupi);

    /* 🔥 THIS IS THE REAL FIX 🔥 */
    if (
      !zapupi.data ||
      String(zapupi.data.status).toLowerCase() !== "success"
    ) {
      await orderRef.update({ locked: false });
      return res.status(200).send("Not paid");
    }

    /* CREDIT USING STORED AMOUNT ONLY */
    await db.ref(`users/${uid}/wallet/deposited`)
      .transaction(v => (Number(v) || 0) + Number(storedAmount));

    await db.ref().update({
      [`orders/${order_id}/status`]: "success",
      [`orders/${order_id}/locked`]: false,
      [`orders/${order_id}/confirmedAt`]: Date.now(),
      [`users/${uid}/transactions/${order_id}/status`]: "success",
      [`users/${uid}/transactions/${order_id}/confirmedAt`]: Date.now()
    });

    console.log("Payment securely credited:", order_id);

    return res.status(200).send("OK");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).send("Error");
  }
});
/* ======================================================
   🔐 SECURE JOIN MATCH (RACE CONDITION PROOF)
====================================================== */
app.post("/join-match", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { matchId, ign } = req.body;

    if (!matchId || !ign || ign.trim().length < 1)
      return res.status(400).json({ error: "INVALID_DATA" });

    const matchRef = db.ref(`matches/${matchId}`);
    const userWalletRef = db.ref(`users/${uid}/wallet`);
    const playerRef = db.ref(`matches/${matchId}/players/${uid}`);
    const joinedRef = db.ref(`users/${uid}/myMatches/${matchId}`);

    /* ===============================
       STEP 1: CHECK ALREADY JOINED
    =============================== */
    const alreadySnap = await playerRef.once("value");
    if (alreadySnap.exists())
      return res.json({ error: "ALREADY_JOINED" });

    /* ===============================
       STEP 2: ATOMIC MATCH SLOT LOCK
    =============================== */
    const matchTxn = await matchRef.transaction(match => {
      if (!match) return match;

      if (!match.players) match.players = 0;

      if (match.players >= match.slots) {
        return; // abort
      }

      match.players += 1;
      return match;
    });

    if (!matchTxn.committed)
      return res.json({ error: "MATCH_FULL" });

    const matchData = matchTxn.snapshot.val();
    const entryFee = Number(matchData.entryFee || 0);

    /* ===============================
       STEP 3: ATOMIC WALLET DEDUCTION
       deposit first, then winnings
    =============================== */
    const walletTxn = await userWalletRef.transaction(wallet => {
      if (!wallet) wallet = { deposited: 0, winnings: 0 };

      let deposited = Number(wallet.deposited || 0);
      let winnings = Number(wallet.winnings || 0);

      const total = deposited + winnings;
      if (total < entryFee) return; // abort

      let depositUsed = 0;
      let winningsUsed = 0;

      if (deposited >= entryFee) {
        depositUsed = entryFee;
        deposited -= entryFee;
      } else {
        depositUsed = deposited;
        winningsUsed = entryFee - deposited;
        deposited = 0;
        winnings -= winningsUsed;
      }

      wallet.deposited = deposited;
      wallet.winnings = winnings;

      wallet._deductionMeta = {
        depositUsed,
        winningsUsed
      };

      return wallet;
    });

    if (!walletTxn.committed) {
      // rollback slot
      await matchRef.child("players").transaction(p => (p || 1) - 1);
      return res.json({ error: "INSUFFICIENT_BALANCE" });
    }

    const deductionMeta = walletTxn.snapshot.val()._deductionMeta;

    /* ===============================
       STEP 4: SAVE PLAYER INFO
    =============================== */
    await db.ref().update({
      [`matches/${matchId}/players/${uid}`]: {
        ign: ign.trim(),
        depositUsed: deductionMeta.depositUsed,
        winningsUsed: deductionMeta.winningsUsed,
        joinedAt: Date.now()
      },
      [`users/${uid}/myMatches/${matchId}`]: {
        joinedAt: Date.now()
      },
      [`users/${uid}/ign-latest`]: ign.trim()
    });

    return res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("JOIN ERROR:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () =>
  console.log("Server running securely")
);
