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

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
  }),
  databaseURL: process.env.FB_DB_URL
});

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
    res.status(401).json({ error: "Invalid token" });
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
    if (!amount || amount < 1) return res.status(400).json({ error: "Invalid amount" });

    const orderId = "ORD" + Date.now();

    const redirectUrl =
      "https://testingwithme.infinityfree.me/wallet.html?order_id=" + orderId;

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
      type: "deposit",
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    res.json({ order_id: orderId, payment_url: zapupi.payment_url });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Create payment failed" });
  }
});

/* ======================================================
   VERIFY PAYMENT
====================================================== */
app.post("/verify-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { orderId } = req.body;

    // Check if transaction exists
    const txnRef = db.ref(`users/${uid}/transactions/${orderId}`);
    const snap = await txnRef.once("value");

    if (!snap.exists()) {
      return res.json({ status: "NOT_FOUND" });
    }

    const transaction = snap.val();
    
    // If already marked as success in our database, return SUCCESS immediately
    if (transaction.status === "success") {
      console.log(`Transaction ${orderId} already marked as success`);
      return res.json({ status: "SUCCESS" });
    }

    const amount = Number(transaction.amount);

    // Query Zapupi for order status
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
    
    console.log(`Zapupi response for order ${orderId}:`, zapupi);

    // CORRECTED: Check for success condition properly
    // Zapupi might return success in different fields
    const isSuccess = 
      zapupi.payment_status === "SUCCESS" || 
      zapupi.status === "success" || 
      zapupi.transaction_status === "SUCCESS" ||
      (zapupi.payment_response && zapupi.payment_response.status === "SUCCESS") ||
      (zapupi.order && zapupi.order.payment_status === "SUCCESS");

    if (!isSuccess) {
      // Check if it's failed or just pending
      const isFailed = 
        zapupi.payment_status === "FAILED" || 
        zapupi.status === "failed" ||
        zapupi.transaction_status === "FAILED";
      
      if (isFailed) {
        // Update transaction as failed in our database
        await txnRef.update({ 
          status: "failed",
          updatedAt: Date.now(),
          gatewayResponse: zapupi
        });
        return res.json({ status: "NOT_FOUND" }); // Treat failed as not found for frontend
      }
      
      // Still pending
      return res.json({ status: "PENDING" });
    }

    // SUCCESS - Payment confirmed by Zapupi
    console.log(`Payment SUCCESS for order ${orderId}, crediting wallet...`);

    // CREDIT DEPOSIT WALLET with transaction to ensure idempotency
    const walletRef = db.ref(`users/${uid}/wallet`);
    
    // Use transaction to ensure atomic operation
    await walletRef.transaction((currentWallet) => {
      if (currentWallet === null) {
        return {
          deposit: amount,
          winnings: 0,
          total: amount
        };
      }
      
      // Check if already credited (prevents double credit)
      const currentDeposit = Number(currentWallet.deposit || currentWallet.deposited || 0);
      
      // If amount already matches or exceeds, don't credit again
      // This is an additional safety check
      if (currentDeposit >= amount && transaction.status === "pending") {
        console.log(`Wallet already has sufficient deposit (${currentDeposit}), skipping credit`);
        return currentWallet; // No change
      }
      
      return {
        ...currentWallet,
        deposit: currentDeposit + amount,
        deposited: currentDeposit + amount, // Support both field names
        total: (currentWallet.total || 0) + amount
      };
    });

    // Mark transaction as success in our database
    await txnRef.update({ 
      status: "success",
      updatedAt: Date.now(),
      gatewayResponse: zapupi,
      creditedAt: Date.now()
    });

    // Also update or create a transaction record in a separate collection for history
    await db.ref(`users/${uid}/transactions_history/${orderId}`).set({
      type: "deposit",
      amount,
      status: "success",
      timestamp: transaction.timestamp || Date.now(),
      completedAt: Date.now(),
      orderId
    });

    console.log(`Wallet credited with ₹${amount} for user ${uid}, order ${orderId}`);
    
    // Return SUCCESS to stop frontend polling
    return res.json({ 
      status: "SUCCESS", 
      amount,
      message: "Payment verified and wallet credited"
    });

  } catch (e) {
    console.error("Error in verify-payment:", e);
    // Return PENDING on error so frontend retries
    return res.json({ status: "PENDING" });
  }
});

/* ======================================================
   REQUEST WITHDRAW
====================================================== */
app.post("/request-withdraw", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const amount = Number(req.body.amount);

    const ref = db.ref(`users/${uid}/wallet/winnings`);
    const snap = await ref.once("value");

    if (amount > (snap.val()||0))
      return res.status(403).json({ error: "Insufficient winnings" });

    const id = "WDR_" + Date.now();

    await ref.transaction(v => (Number(v)||0) - amount);

    await db.ref(`users/${uid}/withdrawals/${id}`).set({
      amount,
      status: "pending",
      timestamp: Date.now()
    });

    res.json({ status: "PENDING", id });

  } catch {
    res.status(500).json({ error: "Withdraw failed" });
  }
});

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
