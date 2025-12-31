// Railway Server for Stripe Payment Endpoints
// Deploy this to Railway: https://stripe-backend-production-be07.up.railway.app

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

// Firebase Admin is not needed for this server
// If you need Firestore in the future, uncomment and install firebase-admin:
// const admin = require('firebase-admin');
// const serviceAccount = require('./path-to-service-account.json');
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount)
// });

// Middleware
app.use(cors());
app.use(express.json());

// Store customer mappings (in production, use a database like Firestore)
// Format: { firebaseUserId: stripeCustomerId }
const customerMap = new Map();

// ============================================
// STRIPE ENDPOINTS
// ============================================

// 1. Create or Get Customer
app.post('/api/stripe/create-customer', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
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
    console.error('❌ Error creating customer:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Create Payment Intent
app.post('/api/stripe/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', customerId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
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
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Create Setup Intent (for saving payment methods)
app.post('/api/stripe/create-setup-intent', async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }
    
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });
    
    console.log(`✅ Created setup intent: ${setupIntent.id} for customer: ${customerId}`);
    
    res.json({
      clientSecret: setupIntent.client_secret,
    });
  } catch (error) {
    console.error('❌ Error creating setup intent:', error.message);
    
    // Check if it's the test/live mode mismatch error
    if (error.code === 'resource_missing' && error.message.includes('test mode')) {
      return res.status(400).json({ 
        error: 'CUSTOMER_MODE_MISMATCH',
        message: 'The customer was created with a test Stripe key, but the server is now using a live key. Please delete the stripeCustomerId from Firestore and try again.',
        customerId: customerId
      });
    }
    
    res.status(500).json({ 
      error: error.message,
      type: error.type || 'unknown',
      code: error.code || 'unknown'
    });
  }
});

// 4. Get Payment Methods for a User
app.get('/api/stripe/payment-methods/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get customer ID from mapping (in production, get from database)
    const customerId = customerMap.get(userId);
    
    if (!customerId) {
      return res.json({ paymentMethods: [] });
    }
    
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
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
    console.error('❌ Error fetching payment methods:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Delete Payment Method
app.delete('/api/stripe/payment-methods/:paymentMethodId', async (req, res) => {
  try {
    const { paymentMethodId } = req.params;
    
    await stripe.paymentMethods.detach(paymentMethodId);
    
    console.log(`✅ Deleted payment method: ${paymentMethodId}`);
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error deleting payment method:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STRIPE CONNECT ENDPOINTS
// ============================================

// 6. Create Stripe Connect Account (Express)
app.post('/api/stripe/connect/create-account', async (req, res) => {
  try {
    const { userId, email } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Create Express account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        firebaseUserId: userId,
      },
    });
    
    console.log(`✅ Created Stripe Connect account: ${account.id} for user: ${userId}`);
    
    res.json({
      accountId: account.id,
      accountType: account.type,
    });
  } catch (error) {
    console.error('❌ Error creating Connect account:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7. Create Account Link (for onboarding)
app.post('/api/stripe/connect/create-account-link', async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required' });
    }
    
    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || 'https://viddycall.com/refresh',
      return_url: returnUrl || 'https://viddycall.com/return',
      type: 'account_onboarding',
    });
    
    console.log(`✅ Created account link for: ${accountId}`);
    
    res.json({
      url: accountLink.url,
    });
  } catch (error) {
    console.error('❌ Error creating account link:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Get Connect Account Status
app.get('/api/stripe/connect/account/:accountId/status', async (req, res) => {
  try {
    const { accountId } = req.params;
    
    const account = await stripe.accounts.retrieve(accountId);
    
    // Check if onboarding is complete
    const isOnboardingComplete = account.details_submitted && account.charges_enabled;
    
    console.log(`✅ Retrieved account status for: ${accountId}, complete: ${isOnboardingComplete}`);
    
    res.json({
      accountId: account.id,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      isOnboardingComplete: isOnboardingComplete,
      email: account.email,
    });
  } catch (error) {
    console.error('❌ Error retrieving account status:', error);
    res.status(500).json({ error: error.message });
  }
});

// 9. Transfer to Provider (when call ends)
app.post('/api/stripe/connect/transfer-to-provider', async (req, res) => {
  try {
    const { amount, providerConnectAccountId, callId, metadata } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    
    if (!providerConnectAccountId) {
      return res.status(400).json({ error: 'providerConnectAccountId is required' });
    }
    
    // Create transfer to provider's Connect account
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      destination: providerConnectAccountId,
      metadata: {
        callId: callId || 'unknown',
        type: 'provider_earnings',
        ...(metadata || {}),
      },
    });
    
    console.log(`✅ Created transfer: ${transfer.id} for $${amount} to account: ${providerConnectAccountId}`);
    
    res.json({
      success: true,
      transferId: transfer.id,
      amount: transfer.amount / 100, // Return in dollars
      status: transfer.status,
    });
  } catch (error) {
    console.error('❌ Error creating transfer:', error);
    
    // Handle insufficient balance
    if (error.code === 'balance_insufficient') {
      return res.status(400).json({ 
        error: 'Insufficient available balance',
        code: 'balance_insufficient',
        message: 'Transfer will be retried when funds are available',
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'stripe-api' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Stripe API server running on port ${PORT}`);
  console.log(`🔑 Stripe key configured: ${process.env.STRIPE_SECRET_KEY ? 'YES' : 'NO'}`);
});

module.exports = app;

