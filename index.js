import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ✅ ROOT CHECK (VERY IMPORTANT)
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "ElitePros Backend",
    time: new Date().toISOString()
  });
});

// ✅ CREATE PAYMENT ROUTE
app.post("/create-payment", async (req, res) => {
  try {
    const { amount, userId } = req.body;

    if (!amount || amount < 1 || !userId) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const zapupiResponse = await fetch(
      "https://www.zapupi.com/api/create-payment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ZAPUPI_API_KEY,
          "x-secret-key": process.env.ZAPUPI_SECRET_KEY
        },
        body: JSON.stringify({
          amount: amount,
          currency: "INR",
          redirect_url: "https://example.com/success",
          webhook_url: "https://example.com/webhook/zapupi",
          meta: { userId }
        })
      }
    );

    const data = await zapupiResponse.json();

    if (!data.payment_url) {
      console.error("Zapupi error:", data);
      return res.status(500).json({ error: "Payment creation failed" });
    }

    // 🔥 THIS IS WHAT FRONTEND EXPECTS
    res.json({ url: data.payment_url });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
