const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("✅ Stripe backend is live");
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 1. Create a Custom account with transfers capability
app.post("/create-account", async (req, res) => {
  try {
    const uniqueEmail = `test+${Date.now()}@example.com`;
    console.log(`Creating account for email: ${uniqueEmail}`);

    const account = await stripe.accounts.create({
      type: "custom",
      country: "US",
      email: uniqueEmail,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    console.log(`Account created: ${account.id}`);
    res.json({ accountId: account.id });
  } catch (error) {
    console.error("Error creating account:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Create onboarding session for embedded Stripe SDK
app.post("/create-account-session", async (req, res) => {
  try {
    const { accountId } = req.body;

    const session = await stripe.accountSessions.create({
      account: accountId,
      components: {
        account_onboarding: { enabled: true }
      }
    });

    res.json({ clientSecret: session.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
