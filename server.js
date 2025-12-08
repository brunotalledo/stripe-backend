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
    
    // Check if customer already exists in memory cache
    if (customerMap.has(userId)) {
      const customerId = customerMap.get(userId);
      console.log(`✅ Returning existing customer from cache: ${customerId} for user: ${userId}`);
      return res.json({ customerId });
    }
    
    // If not in cache, search Stripe for existing customer by metadata
    // Note: This searches through customers, which can be slow for many customers
    // In production, consider storing customer ID in Firestore from the app
    try {
      let foundCustomer = null;
      let hasMore = true;
      let startingAfter = null;
      
      // Search through customers in batches
      while (hasMore && !foundCustomer) {
        const searchParams = {
          limit: 100,
        };
        if (startingAfter) {
          searchParams.starting_after = startingAfter;
        }
        
        const existingCustomers = await stripe.customers.list(searchParams);
        
        // Find customer with matching firebaseUserId in metadata
        foundCustomer = existingCustomers.data.find(
          customer => customer.metadata?.firebaseUserId === userId
        );
        
        hasMore = existingCustomers.has_more;
        if (existingCustomers.data.length > 0) {
          startingAfter = existingCustomers.data[existingCustomers.data.length - 1].id;
        }
        
        // Limit search to first 1000 customers to avoid timeout
        if (existingCustomers.data.length < 100) {
          hasMore = false;
        }
      }
      
      if (foundCustomer) {
        // Cache it for future requests
        customerMap.set(userId, foundCustomer.id);
        console.log(`✅ Found existing Stripe customer: ${foundCustomer.id} for user: ${userId}`);
        return res.json({ customerId: foundCustomer.id });
      }
    } catch (searchError) {
      console.log(`⚠️ Could not search for existing customer, will create new one: ${searchError.message}`);
    }
    
    // Create new Stripe customer if not found
    const customer = await stripe.customers.create({
      metadata: {
        firebaseUserId: userId,
      },
    });
    
    // Store mapping in memory cache
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
      setup_future_usage: "off_session", // Save payment method for future use
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
    let customerId = customerMap.get(userId);
    
    // If not in cache, search Stripe for existing customer by metadata
    if (!customerId) {
      try {
        let foundCustomer = null;
        let hasMore = true;
        let startingAfter = null;
        
        // Search through customers in batches
        while (hasMore && !foundCustomer) {
          const searchParams = {
            limit: 100,
          };
          if (startingAfter) {
            searchParams.starting_after = startingAfter;
          }
          
          const existingCustomers = await stripe.customers.list(searchParams);
          
          // Find customer with matching firebaseUserId in metadata
          foundCustomer = existingCustomers.data.find(
            customer => customer.metadata?.firebaseUserId === userId
          );
          
          hasMore = existingCustomers.has_more;
          if (existingCustomers.data.length > 0) {
            startingAfter = existingCustomers.data[existingCustomers.data.length - 1].id;
          }
          
          // Limit search to first 1000 customers to avoid timeout
          if (existingCustomers.data.length < 100) {
            hasMore = false;
          }
        }
        
        if (foundCustomer) {
          customerId = foundCustomer.id;
          // Cache it for future requests
          customerMap.set(userId, customerId);
          console.log(`✅ Found customer ${customerId} for user ${userId} when fetching payment methods`);
        }
      } catch (searchError) {
        console.log(`⚠️ Could not search for customer when fetching payment methods: ${searchError.message}`);
      }
    }
    
    if (!customerId) {
      console.log(`⚠️ No customer ID found for user: ${userId}`);
      return res.json({ paymentMethods: [] });
    }
    
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });
    
    const formatted = paymentMethods.data.map(pm => ({
      token: pm.id,
      type: pm.type || "card", // Default to "card" if type is missing
      last4: pm.card?.last4 || "",
      cardType: pm.card?.brand || "card", // Default to "card" if brand is missing
      expirationMonth: pm.card?.exp_month?.toString() || "",
      expirationYear: pm.card?.exp_year?.toString() || "",
      isDefault: false, // You can implement default logic
    }));
    
    console.log(`✅ Retrieved ${formatted.length} payment methods for user: ${userId} (customer: ${customerId})`);
    
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

// 6. Create Ephemeral Key (for showing saved payment methods in PaymentSheet)
app.post("/api/stripe/create-ephemeral-key", async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: "customerId is required" });
    }
    
    // Create ephemeral key that expires in 1 hour
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: "2024-12-18.acacia" } // Use your Stripe API version
    );
    
    console.log(`✅ Created ephemeral key for customer: ${customerId}`);
    
    res.json({
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (error) {
    console.error("❌ Error creating ephemeral key:", error);
    res.status(500).json({ error: error.message });
  }
});

// 7. Create Payout (Transfer to connected account or direct payout)
// For now, using Transfer API which requires a connected account
// In production, you might want to use Stripe Connect for marketplace payouts
app.post("/api/stripe/create-payout", async (req, res) => {
  try {
    const { userId, amount, currency = "usd", destination } = req.body;
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: "userId and valid amount are required" });
    }
    
    // For Stripe payouts, we need either:
    // 1. A connected account ID (Stripe Connect)
    // 2. Bank account details for direct payout
    
    // Option 1: If using Stripe Connect (recommended for marketplaces)
    if (destination && destination.startsWith("acct_")) {
      // Transfer to connected account
      const transfer = await stripe.transfers.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        destination: destination,
        metadata: {
          firebaseUserId: userId,
        },
      });
      
      console.log(`✅ Created transfer: ${transfer.id} for amount: ${amount} ${currency} to account: ${destination}`);
      
      return res.json({
        success: true,
        payoutId: transfer.id,
        amount: amount,
        currency: currency,
      });
    }
    
    // Option 2: Direct payout to bank account (requires bank account token)
    // This is more complex and requires collecting bank account details
    // For now, we'll return an error suggesting to use Stripe Connect
    return res.status(400).json({ 
      error: "Payout destination required. Please set up a connected account or bank account." 
    });
    
  } catch (error) {
    console.error("❌ Error creating payout:", error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Verify Bank Account (before allowing payouts)
// This endpoint verifies a bank account using micro-deposits or instant verification
app.post("/api/stripe/verify-bank-account", async (req, res) => {
  try {
    const { routingNumber, accountNumber, accountHolderName, accountType } = req.body;
    
    if (!routingNumber || !accountNumber || !accountHolderName) {
      return res.status(400).json({ 
        error: "routingNumber, accountNumber, and accountHolderName are required" 
      });
    }
    
    // Create a bank account token
    const bankAccountToken = await stripe.tokens.create({
      bank_account: {
        country: "US",
        currency: "usd",
        account_holder_type: "individual",
        account_number: accountNumber,
        routing_number: routingNumber,
        account_holder_name: accountHolderName,
      },
    });
    
    // Add the bank account as an external account to verify it
    // Note: This will trigger micro-deposits for verification
    const externalAccount = await stripe.accounts.createExternalAccount(
      process.env.STRIPE_ACCOUNT_ID || "acct_default", // Your Stripe account ID
      {
        external_account: bankAccountToken.id,
      }
    );
    
    console.log(`✅ Bank account added for verification: ${externalAccount.id}`);
    
    res.json({
      success: true,
      externalAccountId: externalAccount.id,
      verificationStatus: externalAccount.status,
      requiresVerification: externalAccount.status !== "verified",
      message: "Bank account added. Please check for micro-deposits (1-2 business days) to verify your account."
    });
  } catch (error) {
    console.error("❌ Error verifying bank account:", error);
    
    if (error.code === "invalid_request_error" && error.message.includes("bank_account")) {
      return res.status(400).json({ 
        error: "Invalid bank account details. Please check your routing and account numbers." 
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// 9. Create Payout using Stripe's Payouts API
// This endpoint creates a payout to a bank account
// IMPORTANT: Bank account should be verified before using this endpoint
app.post("/api/stripe/create-bank-payout", async (req, res) => {
  try {
    const { userId, amount, currency = "usd", routingNumber, accountNumber, accountHolderName, accountType } = req.body;
    
    if (!userId || !amount || amount <= 0 || !routingNumber || !accountNumber || !accountHolderName) {
      return res.status(400).json({ 
        error: "userId, valid amount, routingNumber, accountNumber, and accountHolderName are required" 
      });
    }
    
    // WARNING: This creates a payout without verification
    // In production, you should verify the bank account first using the verify-bank-account endpoint
    // and store the verified external account ID, then use that for payouts
    
    // Create a bank account token
    const bankAccountToken = await stripe.tokens.create({
      bank_account: {
        country: "US",
        currency: currency.toLowerCase(),
        account_holder_type: "individual",
        account_number: accountNumber,
        routing_number: routingNumber,
        account_holder_name: accountHolderName,
      },
    });
    
    // Create a payout using the bank account token
    // Note: This requires your Stripe account to have payouts enabled
    // The bank account will be automatically added as an external account
    // WARNING: If account number is wrong but valid, money goes to wrong account!
    const payout = await stripe.payouts.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency.toLowerCase(),
      method: "standard", // or "instant" for faster payouts (higher fees)
      source_type: "bank_account",
      destination: bankAccountToken.bank_account.id,
      metadata: {
        firebaseUserId: userId,
        accountHolderName: accountHolderName,
        warning: "Unverified bank account - provider entered details directly"
      },
    });
    
    console.log(`✅ Created payout: ${payout.id} for amount: ${amount} ${currency}`);
    console.log(`⚠️ WARNING: Bank account not verified - if account number is wrong, funds may go to wrong account!`);
    
    res.json({
      success: true,
      payoutId: payout.id,
      amount: amount,
      currency: currency,
      status: payout.status,
      warning: "Bank account was not verified. If account details are incorrect, funds may be sent to the wrong account."
    });
  } catch (error) {
    console.error("❌ Error creating bank payout:", error);
    
    // Provide helpful error messages
    if (error.code === "account_invalid" || error.message.includes("account") || error.code === "account_required") {
      return res.status(400).json({ 
        error: "Your Stripe account needs to be set up for payouts. Please complete the setup in your Stripe Dashboard: 1) Verify your identity, 2) Add a bank account, 3) Enable payouts in Settings → Payment methods → Payouts. Visit https://dashboard.stripe.com/settings/payouts" 
      });
    }
    
    if (error.code === "invalid_request_error" && error.message.includes("bank_account")) {
      return res.status(400).json({ 
        error: "Invalid bank account details. Please check your routing and account numbers." 
      });
    }
    
    if (error.code === "payouts_not_allowed" || error.message.includes("payout")) {
      return res.status(400).json({ 
        error: "Payouts are not enabled for your account. Please complete account verification and add a bank account in your Stripe Dashboard at https://dashboard.stripe.com/settings/payouts" 
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
