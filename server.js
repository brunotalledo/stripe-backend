const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("✅ Stripe backend is live");
});

app.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    service: "stripe-backend"
  });
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
        account_onboarding: {
          enabled: true,
          features: {
            disable_stripe_user_authentication: true,
          },
        },
      },
    });

    res.json({ clientSecret: session.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== STRIPE PAYMENT ENDPOINTS =====

// Store customer mappings (in production, use a database like Firestore)
// Format: { firebaseUserId: stripeCustomerId }
const customerMap = new Map();

// 1. Create or Get Stripe Customer
app.post("/api/stripe/create-customer", async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    
    // Check if customer already exists
    if (customerMap.has(userId)) {
      const customerId = customerMap.get(userId);
      console.log(`✅ Returning existing customer: ${customerId} for user: ${userId}`);
      return res.json({ customerId });
    }
    
    // Create new Stripe customer
    const customer = await stripe.customers.create({
      metadata: {
        firebaseUserId: userId,
      },
    });
    
    // Store mapping (in production, save to database)
    customerMap.set(userId, customer.id);
    
    console.log(`✅ Created new Stripe customer: ${customer.id} for user: ${userId}`);
    
    res.json({
      customerId: customer.id,
    });
  } catch (error) {
    console.error("❌ Error creating customer:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Create Payment Intent
app.post("/api/stripe/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "usd", customerId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount is required" });
    }
    
    const paymentIntentData = {
      amount: Math.round(amount), // Ensure it's an integer (cents)
      currency: currency.toLowerCase(),
      automatic_payment_methods: {
        enabled: true,
      },
    };
    
    // Add customer if provided
    if (customerId) {
      paymentIntentData.customer = customerId;
    }
    
    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);
    
    console.log(`✅ Created payment intent: ${paymentIntent.id} for amount: ${amount} ${currency}`);
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("❌ Error creating payment intent:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Create Setup Intent (for saving payment methods)
app.post("/api/stripe/create-setup-intent", async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: "customerId is required" });
    }
    
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });
    
    console.log(`✅ Created setup intent: ${setupIntent.id} for customer: ${customerId}`);
    
    res.json({
      clientSecret: setupIntent.client_secret,
    });
  } catch (error) {
    console.error("❌ Error creating setup intent:", error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Get Payment Methods for a User
app.get("/api/stripe/payment-methods/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get customer ID from mapping (in production, get from database)
    const customerId = customerMap.get(userId);
    
    if (!customerId) {
      return res.json({ paymentMethods: [] });
    }
    
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });
    
    const formatted = paymentMethods.data.map(pm => ({
      token: pm.id,
      type: pm.type,
      last4: pm.card?.last4,
      cardType: pm.card?.brand,
      expirationMonth: pm.card?.exp_month?.toString(),
      expirationYear: pm.card?.exp_year?.toString(),
      isDefault: false, // You can implement default logic
    }));
    
    console.log(`✅ Retrieved ${formatted.length} payment methods for user: ${userId}`);
    
    res.json({ paymentMethods: formatted });
  } catch (error) {
    console.error("❌ Error fetching payment methods:", error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Delete Payment Method
app.delete("/api/stripe/payment-methods/:paymentMethodId", async (req, res) => {
  try {
    const { paymentMethodId } = req.params;
    
    await stripe.paymentMethods.detach(paymentMethodId);
    
    console.log(`✅ Deleted payment method: ${paymentMethodId}`);
    
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error deleting payment method:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
