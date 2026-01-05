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
    // Check if Stripe is configured
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'Server configuration error: STRIPE_SECRET_KEY not set',
        code: 'MISSING_STRIPE_KEY'
      });
    }
    
    const { userId, email } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    console.log(`🔄 Creating Stripe Connect account for user: ${userId}, email: ${email || 'none'}`);
    
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
    console.error('Error details:', {
      type: error.type,
      code: error.code,
      message: error.message,
      raw: error.raw ? JSON.stringify(error.raw) : 'N/A'
    });
    
    // Return more detailed error information
    res.status(500).json({ 
      error: error.message || 'Unknown error',
      type: error.type || 'unknown',
      code: error.code || 'unknown',
      details: error.raw || null
    });
  }
});

// 7. Create OAuth Link (for connecting existing Stripe accounts)
// NOTE: This requires setting up a Stripe Connect platform application
// Get your client_id from: https://dashboard.stripe.com/settings/applications
app.get('/api/stripe/connect/oauth-link', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'Server configuration error: STRIPE_SECRET_KEY not set',
        code: 'MISSING_STRIPE_KEY'
      });
    }
    
    // Check if client_id is configured
    if (!process.env.STRIPE_CLIENT_ID) {
      console.error('❌ STRIPE_CLIENT_ID environment variable is not set');
      return res.status(500).json({ 
        error: 'OAuth Connect requires STRIPE_CLIENT_ID. Please set up a Stripe Connect platform application and add STRIPE_CLIENT_ID to Railway environment variables.',
        code: 'MISSING_CLIENT_ID',
        instructions: '1. Go to https://dashboard.stripe.com/settings/applications\n2. Create a Connect platform application\n3. Copy the Client ID\n4. Add STRIPE_CLIENT_ID to Railway environment variables'
      });
    }
    
    const { returnUrl, refreshUrl, userId } = req.query;
    
    if (!returnUrl || !refreshUrl) {
      return res.status(400).json({ 
        error: 'returnUrl and refreshUrl query parameters are required' 
      });
    }
    
    console.log(`🔄 Creating OAuth link for existing Stripe account`);
    console.log(`   User ID: ${userId || 'none'}`);
    console.log(`   Return URL: ${returnUrl}`);
    console.log(`   Refresh URL: ${refreshUrl}`);
    
    // Create OAuth link for connecting existing Stripe account
    const oauthLink = await stripe.oauth.authorizeUrl({
      client_id: process.env.STRIPE_CLIENT_ID,
      scope: 'read_write',
      redirect_uri: returnUrl,
      state: userId || 'default', // Pass user ID in state to identify user after OAuth
    });
    
    console.log(`✅ Created OAuth link`);
    
    res.json({
      url: oauthLink,
    });
  } catch (error) {
    console.error('❌ Error creating OAuth link:', error);
    console.error('Error details:', {
      type: error.type,
      code: error.code,
      message: error.message,
    });
    
    res.status(500).json({ 
      error: error.message || 'Unknown error',
      type: error.type || 'unknown',
      code: error.code || 'unknown',
    });
  }
});

// 7.5. OAuth Callback (exchange code for account ID)
app.post('/api/stripe/connect/oauth-callback', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ 
        error: 'Server configuration error: STRIPE_SECRET_KEY not set',
        code: 'MISSING_STRIPE_KEY'
      });
    }
    
    const { code, userId } = req.body;
    
    if (!code) {
      return res.status(400).json({ 
        error: 'OAuth code is required' 
      });
    }
    
    console.log(`🔄 Exchanging OAuth code for account ID for user: ${userId || 'unknown'}`);
    
    // Exchange OAuth code for account ID
    const response = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code: code,
    });
    
    const accountId = response.stripe_user_id;
    
    if (!accountId) {
      return res.status(400).json({ 
        error: 'Failed to get account ID from OAuth response' 
      });
    }
    
    console.log(`✅ OAuth account connected: ${accountId}`);
    
    res.json({
      accountId: accountId,
      accountType: 'standard', // OAuth connects Standard accounts
    });
  } catch (error) {
    console.error('❌ Error exchanging OAuth code:', error);
    res.status(500).json({ 
      error: error.message || 'Unknown error',
      type: error.type || 'unknown',
      code: error.code || 'unknown',
    });
  }
});

// 8. Manual Account Link (for testing - link existing account ID)
// This endpoint allows you to manually set an existing Stripe account ID for testing
// In production, you'd use OAuth Connect instead
app.post('/api/stripe/connect/link-existing-account', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'Server configuration error: STRIPE_SECRET_KEY not set',
        code: 'MISSING_STRIPE_KEY'
      });
    }
    
    const { userId, accountId } = req.body;
    
    if (!userId || !accountId) {
      return res.status(400).json({ 
        error: 'userId and accountId are required' 
      });
    }
    
    console.log(`🔄 Linking existing Stripe account ${accountId} for user: ${userId}`);
    
    // Verify the account exists and is accessible
    try {
      const account = await stripe.accounts.retrieve(accountId);
      console.log(`✅ Verified account exists: ${account.id}, type: ${account.type}`);
      
      // Check if it's a Connect account (should start with acct_)
      if (!accountId.startsWith('acct_')) {
        return res.status(400).json({ 
          error: 'Invalid account ID format. Must be a Stripe Connect account ID (starts with acct_)',
          code: 'INVALID_ACCOUNT_ID'
        });
      }
      
      res.json({
        accountId: account.id,
        accountType: account.type,
        detailsSubmitted: account.details_submitted,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        message: 'Account linked successfully. You still need to complete onboarding if not already done.'
      });
    } catch (error) {
      if (error.code === 'resource_missing') {
        return res.status(404).json({ 
          error: 'Account not found. Make sure the account ID is correct and accessible with your Stripe key.',
          code: 'ACCOUNT_NOT_FOUND'
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('❌ Error linking existing account:', error);
    res.status(500).json({ 
      error: error.message || 'Unknown error',
      type: error.type || 'unknown',
      code: error.code || 'unknown',
    });
  }
});

// 7. Create Account Link (for onboarding Express accounts)
app.post('/api/stripe/connect/create-account-link', async (req, res) => {
  try {
    // Check if Stripe is configured
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'Server configuration error: STRIPE_SECRET_KEY not set',
        code: 'MISSING_STRIPE_KEY'
      });
    }
    
    const { accountId, returnUrl, refreshUrl } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required' });
    }
    
    console.log(`🔄 Creating account link for: ${accountId}`);
    console.log(`   Return URL: ${returnUrl || 'default'}`);
    console.log(`   Refresh URL: ${refreshUrl || 'default'}`);
    
    // Stripe REQUIRES HTTPS URLs for account links - custom schemes (viddcall://) are NOT supported
    // Convert custom URL schemes to HTTPS URLs
    let finalReturnUrl = returnUrl || 'https://viddcall.com/stripe-connect-return';
    let finalRefreshUrl = refreshUrl || 'https://viddcall.com/stripe-connect-refresh';
    
    // If custom URL scheme provided, convert to HTTPS
    if (returnUrl && returnUrl.startsWith('viddcall://')) {
      // Convert viddcall://stripe-connect-return to https://viddcall.com/stripe-connect-return
      const path = returnUrl.replace('viddcall://', '');
      finalReturnUrl = `https://viddcall.com/${path}`;
      console.log(`   Converted custom scheme to HTTPS: ${returnUrl} → ${finalReturnUrl}`);
    } else if (returnUrl && returnUrl.startsWith('http')) {
      finalReturnUrl = returnUrl;
    }
    
    if (refreshUrl && refreshUrl.startsWith('viddcall://')) {
      // Convert viddcall://stripe-connect-refresh to https://viddcall.com/stripe-connect-refresh
      const path = refreshUrl.replace('viddcall://', '');
      finalRefreshUrl = `https://viddcall.com/${path}`;
      console.log(`   Converted custom scheme to HTTPS: ${refreshUrl} → ${finalRefreshUrl}`);
    } else if (refreshUrl && refreshUrl.startsWith('http')) {
      finalRefreshUrl = refreshUrl;
    }
    
    console.log(`   Using return URL: ${finalReturnUrl}`);
    console.log(`   Using refresh URL: ${finalRefreshUrl}`);
    
    // Create account link for onboarding
    // Stripe only accepts HTTPS URLs
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: finalRefreshUrl,
      return_url: finalReturnUrl,
      type: 'account_onboarding',
    });
    
    console.log(`✅ Created account link for: ${accountId}`);
    console.log(`   Link URL: ${accountLink.url.substring(0, 50)}...`);
    
    res.json({
      url: accountLink.url,
    });
  } catch (error) {
    console.error('❌ Error creating account link:', error);
    console.error('Error details:', {
      type: error.type,
      code: error.code,
      message: error.message,
      raw: error.raw ? JSON.stringify(error.raw) : 'N/A'
    });
    
    // Return more detailed error information
    res.status(500).json({ 
      error: error.message || 'Unknown error',
      type: error.type || 'unknown',
      code: error.code || 'unknown',
      details: error.raw || null
    });
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

// 9. Create Login Link for Connect Account (direct dashboard access)
app.post('/api/stripe/connect/create-login-link', async (req, res) => {
  try {
    // Check if Stripe is configured
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'Server configuration error: STRIPE_SECRET_KEY not set',
        code: 'MISSING_STRIPE_KEY'
      });
    }
    
    const { accountId } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required' });
    }
    
    console.log(`🔄 Creating login link for Connect account: ${accountId}`);
    
    // First, get the account type to verify it's Express
    const account = await stripe.accounts.retrieve(accountId);
    console.log(`   Account type: ${account.type}`);
    console.log(`   Account ID: ${account.id}`);
    
    // Create a login link for the Connect account
    // For Express accounts, this should redirect to connect.stripe.com
    // The login link is a full URL with authentication tokens
    const loginLink = await stripe.accounts.createLoginLink(accountId);
    
    console.log(`✅ Created login link for account: ${accountId}`);
    console.log(`   Full Login URL: ${loginLink.url}`);
    console.log(`   URL starts with: ${loginLink.url.substring(0, 50)}...`);
    console.log(`   Account type: ${account.type} (Express accounts should go to connect.stripe.com)`);
    
    // Verify the URL format
    if (!loginLink.url || !loginLink.url.startsWith('http')) {
      throw new Error('Invalid login link URL returned from Stripe');
    }
    
    res.json({
      url: loginLink.url,
      accountType: account.type,
    });
  } catch (error) {
    console.error('❌ Error creating login link:', error);
    console.error('Error details:', {
      type: error.type,
      code: error.code,
      message: error.message,
    });
    
    res.status(500).json({ 
      error: error.message || 'Unknown error',
      type: error.type || 'unknown',
      code: error.code || 'unknown',
    });
  }
});

// 10. Transfer to Provider (when call ends)
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
  const hasKey = !!process.env.STRIPE_SECRET_KEY;
  console.log(`🔑 Stripe key configured: ${hasKey ? 'YES' : 'NO'}`);
  if (hasKey) {
    const keyPreview = process.env.STRIPE_SECRET_KEY.substring(0, 7) + '...' + process.env.STRIPE_SECRET_KEY.substring(process.env.STRIPE_SECRET_KEY.length - 4);
    console.log(`🔑 Key preview: ${keyPreview}`);
  } else {
    console.error('⚠️ WARNING: STRIPE_SECRET_KEY is not set! Stripe endpoints will fail.');
  }
});

module.exports = app;

