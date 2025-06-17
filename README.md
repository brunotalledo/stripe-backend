# Stripe Connect Onboarding Backend

## 🔧 Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Run the server:
   ```
   node server.js
   ```

## 📡 Endpoints

- `POST /create-account`  
  Creates a new Stripe Custom connected account (test/demo only).

- `POST /create-account-session`  
  Expects `{ "accountId": "acct_..." }`  
  Returns `{ "clientSecret": "..." }`

## 🌍 Deploying

You can deploy this to:
- Railway: https://railway.app
- Render: https://render.com

Make sure to add `STRIPE_SECRET_KEY` to your environment variables.
