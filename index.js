import express from "express";
import cors from "cors";

const app = express();

/* ===============================
   🔥 CORS
   =============================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors());

app.use(express.json());

/* ===============================
   ✅ ROOT TEST
   =============================== */
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "ElitePros Backend",
    time: new Date().toISOString()
  });
});

/* ===============================
   💳 CREATE ORDER (Zapupi)
   =============================== */
app.post("/create-payment", async (req, res) => {
  try {
    const { amount, userId } = req.body;

    if (!amount || amount < 1 || !userId) {
      return res.status(400).json({ error: "Invalid request" });
    }

    // Generate unique order ID
    const orderId = `ORD_${Date.now()}_${userId.slice(0, 6)}`;

    // 🔥 Build x-www-form-urlencoded body
    const formBody = new URLSearchParams({
      token_key: process.env.ZAPUPI_API_KEY,
      secret_key: process.env.ZAPUPI_SECRET_KEY,
      amount: amount.toString(),
      order_id: orderId,
      customer_mobile: "9999999999", // optional
      remark: "Wallet Deposit"
    });

    const response = await fetch(
      "https://api.zapupi.com/api/create-order",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: formBody.toString()
      }
    );

    const text = await response.text();
    console.log("Zapupi raw:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({
        error: "Zapupi returned non-JSON",
        raw: text
      });
    }

    if (data.status !== "success") {
      return res.status(500).json({
        error: "Zapupi order failed",
        zapupi: data
      });
    }

    // 🔥 Zapupi usually returns a payment URL / QR / intent
    res.json({
      order_id: orderId,
      zapupi: data
    });

  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
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
