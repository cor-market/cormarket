const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARIABLES (set these in Railway) ──
const GMAIL_USER          = process.env.GMAIL_USER;         // rynxzas@gmail.com
const GMAIL_PASS          = process.env.GMAIL_PASS;         // your app password
const PAYPAL_EMAIL        = process.env.PAYPAL_EMAIL;       // rynxzas@gmail.com
const FRONTEND_URL        = process.env.FRONTEND_URL;       // your Railway frontend URL
const PAYPAL_CLIENT_ID    = process.env.PAYPAL_CLIENT_ID;   // from PayPal developer dashboard
const PAYPAL_CLIENT_SECRET= process.env.PAYPAL_CLIENT_SECRET; // from PayPal developer dashboard
const PAYPAL_WEBHOOK_ID   = process.env.PAYPAL_WEBHOOK_ID;  // 8X8059865A171644P

// ── NODEMAILER SETUP ──
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

// ── PENDING ORDERS STORE (in-memory) ──
// Format: { [corOrderId]: { email, items, total, paid } }
const pendingOrders = {};

// ── PAYPAL ACCESS TOKEN ──
async function getPayPalAccessToken() {
  const res = await axios.post(
    'https://api-m.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    {
      auth: {
        username: PAYPAL_CLIENT_ID,
        password: PAYPAL_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return res.data.access_token;
}

// ── VERIFY PAYPAL WEBHOOK SIGNATURE ──
async function verifyWebhookSignature(req, eventBody) {
  try {
    const accessToken = await getPayPalAccessToken();

    const verifyPayload = {
      auth_algo:         req.headers['paypal-auth-algo'],
      cert_url:          req.headers['paypal-cert-url'],
      transmission_id:   req.headers['paypal-transmission-id'],
      transmission_sig:  req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id:        PAYPAL_WEBHOOK_ID,
      webhook_event:     eventBody,
    };

    const verifyRes = await axios.post(
      'https://api-m.paypal.com/v1/notifications/verify-webhook-signature',
      verifyPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return verifyRes.data.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('[WEBHOOK VERIFY ERROR]', err.message);
    return false;
  }
}

app.use(cors({ origin: '*' }));

// ── RAW BODY for webhook verification (must be before bodyParser) ──
app.use('/api/paypal-webhook', express.raw({ type: 'application/json' }));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.send('Cor Market server is running.');
});

// ── STEP 1: Frontend registers a pending order before redirecting to PayPal ──
app.post('/api/register-order', (req, res) => {
  const { orderId, email, items, total } = req.body;

  if (!orderId || !email || !items || !total) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  pendingOrders[orderId] = { email, items, total, paid: false };
  console.log(`[ORDER REGISTERED] ${orderId} for ${email} — $${total}`);
  res.json({ success: true, orderId });
});

// ── STEP 2: Frontend polls to check if order has been paid ──
app.get('/api/order-status/:orderId', (req, res) => {
  const order = pendingOrders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ paid: order.paid, email: order.email });
});

// ── STEP 3: PayPal Webhook hits this endpoint ──
app.post('/api/paypal-webhook', async (req, res) => {
  // Respond 200 immediately so PayPal doesn't retry
  res.sendStatus(200);

  let eventBody;
  try {
    eventBody = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('[WEBHOOK] Failed to parse body:', e.message);
    return;
  }

  console.log('[WEBHOOK RECEIVED] event_type:', eventBody.event_type);

  // Verify the webhook signature with PayPal
  const isValid = await verifyWebhookSignature(req, eventBody);
  if (!isValid) {
    console.log('[WEBHOOK] Signature verification failed — ignoring.');
    return;
  }

  // We only care about completed payments
  if (eventBody.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
    console.log('[WEBHOOK] Ignoring event type:', eventBody.event_type);
    return;
  }

  // Extract the custom_id (your COR- order ID) from the payment resource
  const resource   = eventBody.resource || {};
  const customId   = resource.custom_id || '';
  const payeeEmail = resource.payee?.email_address || '';

  console.log(`[WEBHOOK] custom_id=${customId} payee=${payeeEmail}`);

  // Make sure the payment went to your PayPal
  if (payeeEmail.toLowerCase() !== PAYPAL_EMAIL.toLowerCase()) {
    console.log('[WEBHOOK] Wrong payee, ignoring.');
    return;
  }

  // Find the matching pending order
  const match = customId.match(/COR-[A-Z0-9-]+/);
  if (!match) {
    console.log('[WEBHOOK] No COR- order ID found in custom_id:', customId);
    return;
  }

  const orderId = match[0];
  const order   = pendingOrders[orderId];

  if (!order) {
    console.log('[WEBHOOK] Order not found:', orderId);
    return;
  }

  if (order.paid) {
    console.log('[WEBHOOK] Order already processed:', orderId);
    return;
  }

  // Mark as paid and send delivery
  order.paid = true;
  console.log(`[WEBHOOK] Order ${orderId} marked PAID — sending delivery to ${order.email}`);
  await sendDeliveryEmail(order, orderId);
});

// ── SEND DELIVERY EMAIL ──
async function sendDeliveryEmail(order, orderId) {
  const itemRows = order.items.map(p =>
    `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #2a1530;font-size:14px">${p.icon} ${p.name}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #2a1530;font-family:monospace;font-size:14px;color:#f72585">${p.delivery || 'N/A'}</td>
    </tr>`
  ).join('');

  const html = `
  <div style="background:#0f0812;color:#fde8f0;font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid #3a1f3e">
    <div style="background:linear-gradient(135deg,#f72585,#b5179e);padding:32px;text-align:center">
      <h1 style="margin:0;font-size:28px;color:#fff;letter-spacing:-1px">Cor Market</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Your order has been delivered!</p>
    </div>
    <div style="padding:32px">
      <p style="color:#c994b0;font-size:14px;margin:0 0 8px">Order ID</p>
      <p style="font-family:monospace;font-size:16px;color:#f72585;margin:0 0 24px;background:#1a0e1f;padding:10px 16px;border-radius:8px;display:inline-block">${orderId}</p>

      <p style="color:#c994b0;font-size:14px;margin:0 0 12px">Your items</p>
      <table style="width:100%;border-collapse:collapse;background:#1a0e1f;border-radius:10px;overflow:hidden;margin-bottom:24px">
        <thead>
          <tr>
            <th style="padding:10px 14px;text-align:left;font-size:11px;color:#7a4a68;letter-spacing:0.1em;text-transform:uppercase;border-bottom:1px solid #2a1530">Product</th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;color:#7a4a68;letter-spacing:0.1em;text-transform:uppercase;border-bottom:1px solid #2a1530">Delivery Info</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <p style="font-size:12px;color:#7a4a68;text-align:center;margin:0">
        Need help? Reply to this email and we'll sort it out fast.<br>
        Thank you for shopping at Cor Market ✦
      </p>
    </div>
  </div>`;

  await transporter.sendMail({
    from: `"Cor Market" <${GMAIL_USER}>`,
    to: order.email,
    subject: `✅ Your Cor Market Order — ${orderId}`,
    html,
  });

  console.log(`[EMAIL SENT] Delivery email sent to ${order.email}`);
}

app.listen(PORT, () => {
  console.log(`Cor Market server running on port ${PORT}`);
});
