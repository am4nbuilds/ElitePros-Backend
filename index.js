import express from "express";
import cors from "cors";

const app = express();

/* ===============================
   🔥 CORS — MUST BE FIRST
   =============================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

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

    console.log("➡️ Creating payment:", { amount, userId });

    // ✅ Use native fetch (Node 18+ on Render)
    const response = await fetch(
      "https://api.zapupi.com/api/v1/payment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ZAPUPI_API_KEY,
          "x-secret-key": process.env.ZAPUPI_SECRET_KEY
        },
        body: JSON.stringify({
          amount,
          currency: "INR",
          redirect_url: "https://imaginative-lolly-654a8a.netlify.app/success.html",
          webhook_url: "https://elitepros-backend.onrender.com/webhook/zapupi",
          meta: { userId }
        })
      }
    );

    // 🔥 Read raw response first (critical for debugging)
    const rawText = await response.text();
    console.log("⬅️ Zapupi raw response:", rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        error: "Zapupi returned non-JSON response",
        raw: rawText
      });
    }

    if (!response.ok) {
      return res.status(500).json({
        error: "Zapupi API error",
        zapupi: data
      });
    }

    if (!data.payment_url) {
      return res.status(500).json({
        error: "payment_url missing in Zapupi response",
        zapupi: data
      });
    }

    // ✅ SUCCESS
    res.json({ url: data.payment_url });

  } catch (err) {
    console.error("🔥 CREATE-PAYMENT CRASH:", err);
    res.status(500).json({
      error: "Server error",
      details: err.message
    });
  }
});

/* ===============================
   🚀 START SERVER
   =============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
