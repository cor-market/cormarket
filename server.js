const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARIABLES (set these in Railway) ──
const GMAIL_USER     = process.env.GMAIL_USER;      // rynxzas@gmail.com
const GMAIL_PASS     = process.env.GMAIL_PASS;      // your app password
const PAYPAL_EMAIL   = process.env.PAYPAL_EMAIL;    // rynxzas@gmail.com
const FRONTEND_URL   = process.env.FRONTEND_URL;    // your Railway frontend URL

// ── NODEMAILER SETUP ──
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

// ── PENDING ORDERS STORE (in-memory) ──
// Format: { [corOrderId]: { email, items, total, note } }
const pendingOrders = {};

app.use(cors({ origin: '*' }));
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

// ── STEP 3: PayPal IPN hits this endpoint to confirm payment ──
app.post('/api/paypal-ipn', async (req, res) => {
  // Immediately respond 200 to PayPal
  res.sendStatus(200);

  const ipnData = req.body;
  console.log('[IPN RECEIVED]', ipnData);

  // Send back to PayPal to verify
  try {
    const verifyUrl = 'https://ipnpb.paypal.com/cgi-bin/webscr';
    const verifyBody = 'cmd=_notify-validate&' +
      Object.entries(ipnData)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

    const verifyRes = await axios.post(verifyUrl, verifyBody, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (verifyRes.data !== 'VERIFIED') {
      console.log('[IPN] Not verified, ignoring.');
      return;
    }

    // Check payment status and receiver
    const status   = ipnData.payment_status;
    const receiver = ipnData.receiver_email;
    const memo     = ipnData.memo || ipnData.item_name || '';

    console.log(`[IPN VERIFIED] status=${status} receiver=${receiver} memo=${memo}`);

    if (status !== 'Completed') return;
    if (receiver.toLowerCase() !== PAYPAL_EMAIL.toLowerCase()) {
      console.log('[IPN] Wrong receiver, ignoring.');
      return;
    }

    // Find the matching pending order by the COR- order ID in the memo
    const match = memo.match(/COR-[A-Z0-9-]+/);
    if (!match) {
      console.log('[IPN] No order ID found in memo:', memo);
      return;
    }

    const orderId = match[0];
    const order   = pendingOrders[orderId];

    if (!order) {
      console.log('[IPN] Order not found in pending store:', orderId);
      return;
    }

    if (order.paid) {
      console.log('[IPN] Order already processed:', orderId);
      return;
    }

    // Mark as paid
    order.paid = true;
    console.log(`[IPN] Order ${orderId} marked as PAID — sending delivery to ${order.email}`);

    // Send delivery email
    await sendDeliveryEmail(order, orderId);

  } catch (err) {
    console.error('[IPN ERROR]', err.message);
  }
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
