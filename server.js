// NP Compass API Server
// Environment variables required on Render:
//   ANTHROPIC_API_KEY      — Anthropic API key
//   STRIPE_SECRET_KEY      — Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
//   STRIPE_PRICE_ID        — Price ID for $20/month plan (price_...)
//   CLIENT_URL             — https://np-compass.com

const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Webhook needs raw body — must come BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(cors({
  origin: [
    'https://np-compass.com',
    'https://www.np-compass.com',
    'http://localhost:3000',
    /\.netlify\.app$/
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLIENT_URL = process.env.CLIENT_URL || 'https://np-compass.com';
const PRICE_ID   = process.env.STRIPE_PRICE_ID;
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

// Helper — get Stripe customer and best subscription for an email
async function getSubForEmail(email) {
  const customers = await stripe.customers.list({ email, limit: 1 });
  if (!customers.data.length) return null;
  const customer = customers.data[0];
  const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 });
  const subscription = subs.data.find(s => ACTIVE_STATUSES.has(s.status)) || subs.data[0] || null;
  return { customer, subscription };
}

// Anthropic proxy
app.post('/api', async (req, res) => {
  try {
    const { model, max_tokens, system, messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });
    const response = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 1200,
      system: system || '',
      messages
    });
    res.json(response);
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Subscription status — primary access control
app.get('/sub-status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const result = await getSubForEmail(email);
    if (!result) return res.json({ access: false, status: 'no_customer', email });
    const { customer, subscription } = result;
    if (!subscription) return res.json({ access: false, status: 'no_subscription', stripeCustomerId: customer.id, email });
    res.json({
      access: ACTIVE_STATUSES.has(subscription.status),
      status: subscription.status,
      stripeCustomerId: customer.id,
      subscriptionId: subscription.id,
      trialEnd: subscription.trial_end,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      email
    });
  } catch (err) {
    console.error('Sub status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create checkout — with duplicate prevention
app.post('/create-checkout', async (req, res) => {
  try {
    const { email, uid, name, successUrl, cancelUrl } = req.body;
    if (!email || !uid) return res.status(400).json({ error: 'email and uid required' });

    // Duplicate check — if already active/trialing send to portal
    const existing = await getSubForEmail(email);
    if (existing?.subscription && ACTIVE_STATUSES.has(existing.subscription.status)) {
      const portal = await stripe.billingPortal.sessions.create({
        customer: existing.customer.id,
        return_url: successUrl || CLIENT_URL
      });
      return res.json({ alreadySubscribed: true, url: portal.url, status: existing.subscription.status });
    }

    // Get or create customer
    let customerId = existing?.customer?.id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email, name: name || email, metadata: { uid } });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 7, metadata: { uid, email } },
      metadata: { uid, email },
      success_url: successUrl || `${CLIENT_URL}?session_id={CHECKOUT_SESSION_ID}&uid=${uid}`,
      cancel_url: cancelUrl || CLIENT_URL,
      allow_promotion_codes: true
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify success — called after Stripe redirect, confirms with Stripe directly
app.get('/verify-success', async (req, res) => {
  try {
    const { session_id, email } = req.query;

    if (session_id) {
      const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription', 'customer'] });
      const sub = session.subscription;
      const completed = session.status === 'complete' || session.payment_status === 'paid';
      return res.json({
        access: completed,
        status: sub?.status || (completed ? 'trialing' : session.status),
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        subscriptionId: sub?.id,
        trialEnd: sub?.trial_end,
        verified: true,
        source: 'checkout_session'
      });
    }

    if (email) {
      const result = await getSubForEmail(email);
      if (result?.subscription && ACTIVE_STATUSES.has(result.subscription.status)) {
        return res.json({
          access: true,
          status: result.subscription.status,
          stripeCustomerId: result.customer.id,
          subscriptionId: result.subscription.id,
          trialEnd: result.subscription.trial_end,
          verified: true,
          source: 'email_lookup'
        });
      }
      return res.json({ access: false, status: 'not_found', verified: false });
    }

    res.status(400).json({ error: 'session_id or email required' });
  } catch (err) {
    console.error('Verify success error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Customer portal
app.post('/create-portal', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'No Stripe customer found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: returnUrl || CLIENT_URL
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  async function resolveEmail(obj) {
    if (obj.metadata?.email) return obj.metadata.email;
    if (obj.customer_email)  return obj.customer_email;
    if (obj.customer) {
      try { const c = await stripe.customers.retrieve(obj.customer); return c.email; } catch { return null; }
    }
    return null;
  }

  try {
    const email = await resolveEmail(obj);
    switch (event.type) {
      case 'checkout.session.completed':
        console.log(`✓ Checkout completed — ${email || obj.customer}`); break;
      case 'customer.subscription.created':
        console.log(`✓ Subscription created — ${obj.status} — ${email || obj.customer}`); break;
      case 'customer.subscription.updated':
        console.log(`✓ Subscription updated — ${obj.status} — ${email || obj.customer}`); break;
      case 'customer.subscription.deleted':
        console.log(`✗ Subscription canceled — ${email || obj.customer}`); break;
      case 'customer.subscription.trial_will_end':
        const days = Math.ceil((obj.trial_end - Date.now()/1000) / 86400);
        console.log(`⚠ Trial ending in ${days}d — ${email || obj.customer}`); break;
      case 'invoice.payment_succeeded':
        console.log(`✓ Payment succeeded — ${email || obj.customer}`); break;
      case 'invoice.payment_failed':
        console.log(`✗ Payment failed — ${email || obj.customer}`); break;
      default:
        console.log(`Event: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    stripe: !!process.env.STRIPE_SECRET_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    priceId: process.env.STRIPE_PRICE_ID || 'not set',
    clientUrl: CLIENT_URL
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`NP Compass API running on port ${PORT}`));

