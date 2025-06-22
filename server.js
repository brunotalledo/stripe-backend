const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
app.use(express.json());

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
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-account-link", async (req, res) => {
  try {
    const { accountId } = req.body;

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: "https://viddycall.com/reauth",
      return_url: "https://viddycall.com/success",
      type: "account_onboarding"
    });

    res.json({ url: accountLink.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
