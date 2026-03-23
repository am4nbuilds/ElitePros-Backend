import express from "express";
import fetch from "node-fetch";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const orderId = "TEST" + Date.now();

    const response = await fetch("https://api.cashfree.com/pg/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01"
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",
        customer_details: {
          customer_id: "test_user",
          customer_email: "test@test.com",
          customer_phone: "9999999999"
        }
      })
    });

    const data = await response.json();

    console.log("CASHFREE RESPONSE:", data);

    res.json(data);

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
