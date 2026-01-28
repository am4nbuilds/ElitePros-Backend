import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();

/* ===============================
   🔥 CORS — MUST BE FIRST
   =============================== */
app.use(cors({
  origin: "*", // allow Netlify, localhost, etc.
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Handle preflight requests explicitly
app.options("*", cors());

app.use(express.json());

/* ===============================
   ✅ ROOT TEST ROUTE
   =============================== */
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "ElitePros Backend",
    time: new Date().toISOString()
  });
});

/* ===============================
   💳 CREATE PAYMENT (Zapupi)
   =============================== */
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
          redirect_url: "https://imaginative-lolly-654a8a.netlify.app/success.html",
          webhook_url: "https://elitepros-backend.onrender.com/webhook/zapupi",
          meta: { userId }
        })
      }
    );

    const data = await zapupiResponse.json();

    if (!data.payment_url) {
      console.error("Zapupi error:", data);
      return res.status(500).json({ error: "Payment creation failed" });
    }

    // 🔥 FRONTEND EXPECTS THIS
    res.json({ url: data.payment_url });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===============================
   🚀 START SERVER
   =============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
