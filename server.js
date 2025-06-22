const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post("/create-account", async (req, res) => {
  const account = await stripe.accounts.create({
    type: "custom",
    country: "US",
    email: "test@example.com"
  });
  res.json({ accountId: account.id });
});

app.post("/create-account-session", async (req, res) => {
  const { accountId } = req.body;

  const session = await stripe.accountSessions.create({
    account: accountId,
    components: {
      account_onboarding: { enabled: true }
    }
  });

  res.json({ clientSecret: session.client_secret });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});
