const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
app.use(express.json());

// Add a simple root route to verify server is working
app.get("/", (req, res) => {
  res.send("✅ Stripe backend is live");
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post("/create-account", async (req, res) => {
  try {
    const account = await stripe.accounts.create({
      type: "custom",
      country: "US",
      email: "test@example.com"
    });
    res.json({ accountId: account.id });
  } catch (error) {
    console.error("Error creating account:", error);
    res.status(500).json({ error: error.message });
  }
});

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
    console.error("Error creating account session:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
