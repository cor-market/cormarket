// cache bust 1
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS — must be first, before everything ──
app.use(cors({ origin: '*' }));
app.options('*', cors({ origin: '*' }));

// ── ENV VARIABLES ──
const GMAIL_USER           = process.env.GMAIL_USER;
const GMAIL_PASS           = process.env.GMAIL_PASS;
const PAYPAL_EMAIL         = process.env.PAYPAL_EMAIL;
const FRONTEND_URL         = process.env.FRONTEND_URL;
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID    = process.env.PAYPAL_WEBHOOK_ID;

// ── BODY PARSERS — after cors ──
app.use('/api/paypal-webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ── NODEMAILER ──
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// ── IN-MEMORY STORES ──
const pendingOrders = {};
const reviews = [];

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('Cor Market server is running.'));

// ── REGISTER ORDER ──
app.post('/api/register-order', (req, res) => {
  const { orderId, email, items, total } = req.body;
  if (!orderId || !email || !items || !total) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  pendingOrders[orderId] = { email, items, total, paid: false };
  console.log(`[ORDER REGISTERED] ${orderId} for ${email}`);
  res.json({ success: true, orderId });
});

// ── ORDER STATUS ──
app.get('/api/order-status/:orderId', (req, res) => {
  const order = pendingOrders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ paid: order.paid, email: order.email });
});

// ── GET REVIEWS ──
app.get('/api/reviews', (req, res) => {
  res.json({ reviews });
});

// ── SUBMIT REVIEW ──
app.post('/api/submit-review', (req, res) => {
  const { orderId, rating, text } = req.body;
  if (!orderId || !rating || !text) return res.status(400).json({ error: 'Missing fields.' });
  const order = pendingOrders[orderId];
  if (!order) return res.status(404).json({ error: 'Order ID not found.' });
  if (!order.paid) return res.status(403).json({ error: 'Payment not confirmed.' });
  if (order.reviewed) return res.status(409).json({ error: 'Already reviewed.' });
  if (text.length < 10 || text.length > 500) return res.status(400).json({ error: 'Review must be 10-500 characters.' });
  order.reviewed = true;
  reviews.unshift({ text, rating, author: 'Verified Buyer · just now' });
  console.log(`[REVIEW] ${orderId} left ${rating} stars`);
  res.json({ success: true });
});

// ── PAYPAL ACCESS TOKEN ──
async function getPayPalAccessToken() {
  const res = await axios.post(
    'https://api-m.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    { auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data.access_token;
}

// ── VERIFY WEBHOOK SIGNATURE ──
async function verifyWebhookSignature(req, eventBody) {
  try {
    const accessToken = await getPayPalAccessToken();
    const verifyRes = await axios.post(
      'https://api-m.paypal.com/v1/notifications/verify-webhook-signature',
      {
        auth_algo:         req.headers['paypal-auth-algo'],
        cert_url:          req.headers['paypal-cert-url'],
        transmission_id:   req.headers['paypal-transmission-id'],
        transmission_sig:  req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id:        PAYPAL_WEBHOOK_ID,
        webhook_event:     eventBody,
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return verifyRes.data.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('[WEBHOOK VERIFY ERROR]', err.message);
    return false;
  }
}

// ── PAYPAL WEBHOOK ──
app.post('/api/paypal-webhook', async (req, res) => {
  res.sendStatus(200);
  let eventBody;
  try { eventBody = JSON.parse(req.body.toString()); }
  catch (e) { console.error('[WEBHOOK] Parse error:', e.message); return; }

  console.log('[WEBHOOK] event_type:', eventBody.event_type);
  const isValid = await verifyWebhookSignature(req, eventBody);
  if (!isValid) { console.log('[WEBHOOK] Invalid signature'); return; }
  if (eventBody.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return;

  const resource = eventBody.resource || {};
  const customId = resource.custom_id || '';
  const payeeEmail = resource.payee?.email_address || '';

  if (payeeEmail.toLowerCase() !== PAYPAL_EMAIL.toLowerCase()) return;

  const match = customId.match(/COR-[A-Z0-9-]+/);
  if (!match) return;

  const orderId = match[0];
  const order = pendingOrders[orderId];
  if (!order || order.paid) return;

  order.paid = true;
  console.log(`[WEBHOOK] ${orderId} PAID — sending to ${order.email}`);
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
      <h1 style="margin:0;font-size:28px;color:#fff">Cor Market</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Your order has been delivered!</p>
    </div>
    <div style="padding:32px">
      <p style="color:#c994b0;font-size:14px;margin:0 0 8px">Order ID</p>
      <p style="font-family:monospace;font-size:16px;color:#f72585;margin:0 0 24px;background:#1a0e1f;padding:10px 16px;border-radius:8px;display:inline-block">${orderId}</p>
      <table style="width:100%;border-collapse:collapse;background:#1a0e1f;border-radius:10px;overflow:hidden;margin-bottom:24px">
        <thead><tr>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#7a4a68;letter-spacing:0.1em;text-transform:uppercase;border-bottom:1px solid #2a1530">Product</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#7a4a68;letter-spacing:0.1em;text-transform:uppercase;border-bottom:1px solid #2a1530">Delivery</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <p style="font-size:12px;color:#7a4a68;text-align:center;margin:0">Thank you for shopping at Cor Market ✦</p>
    </div>
  </div>`;

  await transporter.sendMail({
    from: `"Cor Market" <${GMAIL_USER}>`,
    to: order.email,
    subject: `✅ Your Cor Market Order — ${orderId}`,
    html,
  });
  console.log(`[EMAIL] Sent to ${order.email}`);
}

app.listen(PORT, () => console.log(`Cor Market server running on port ${PORT}`));
