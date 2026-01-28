import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();

/* ===============================
   🔥 CORS
=============================== */
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ===============================
   🔥 FIREBASE ADMIN
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
   🔥 TEST UID (TEMP)
=============================== */
const TEST_UID = "kNABqZe4O7Pj1UuagQ7n3887zB62";

/* ===============================
   ✅ CREATE ORDER
=============================== */
app.post("/create-payment", async (req, res) => {
  const { amount } = req.body;

  const orderId =
    "ORD" + Math.floor(100000000 + Math.random() * 900000000);

  const body = new URLSearchParams({
    token_key: process.env.ZAPUPI_API_KEY,
    secret_key: process.env.ZAPUPI_SECRET_KEY,
    amount: amount.toString(),
    order_id: orderId,
    remark: "Wallet Deposit"
  });

  const response = await fetch("https://api.zapupi.com/api/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await response.json();

  // Save pending transaction
  await db.ref(`users/${TEST_UID}/transactions/${orderId}`).set({
    order_id: orderId,
    amount,
    status: "PENDING",
    created_at: Date.now()
  });

  res.json({
    order_id: orderId,
    payment_url: data.payment_url,
    auto_check: data.auto_check_every_2_sec
  });
});

/* ===============================
   🔁 AUTO CHECK (WEBHOOK-LIKE)
=============================== */
app.post("/check-status", async (req, res) => {
  const { orderId } = req.body;

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

  const data = await response.json();

  if (data.status !== "success") {
    return res.json({ status: "PENDING" });
  }

  const txnRef = db.ref(
    `users/${TEST_UID}/transactions/${orderId}`
  );

  const snap = await txnRef.once("value");
  if (snap.val()?.status === "SUCCESS") {
    return res.json({ status: "ALREADY_DONE" });
  }

  // ✅ Update wallet
  await db.ref(`users/${TEST_UID}/wallet/deposited`)
    .transaction(v => (v || 0) + Number(data.amount));

  // ✅ Save transaction
  await txnRef.update({
    status: "SUCCESS",
    utr: data.utr,
    txn_id: data.txn_id,
    completed_at: Date.now()
  });

  res.json({ status: "SUCCESS" });
});

/* ===============================
   🚀 START SERVER
=============================== */
app.listen(process.env.PORT || 3000);
