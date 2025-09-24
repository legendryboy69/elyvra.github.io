// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Razorpay = require('razorpay');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nanoid } = require('nanoid');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Config
const PORT = process.env.PORT || 3000;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DOWNLOAD_TOKEN_TTL_MIN = parseInt(process.env.DOWNLOAD_TOKEN_TTL_MIN || '60', 10);

// Razorpay client
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// Simple flat-file DB (for demo). Replace with real DB in production
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

// Ensure data files exist
if (!fs.existsSync(PRODUCTS_FILE)) {
  const sampleProducts = [
    {
      "id": "prod-ebook-1",
      "title": "Mastering Productivity (eBook)",
      "description": "100 pages of productivity hacks and templates.",
      "priceINR": 199,       // INR
      "filename": "mastering-productivity.pdf",
      "thumbnail": "/assets/ebook-thumb.png"
    },
    {
      "id": "prod-templates-1",
      "title": "UI Kit & Templates",
      "description": "Collection of 20 modern UI templates (Figma).",
      "priceINR": 499,
      "filename": "ui-kit-templates.zip",
      "thumbnail": "/assets/templates-thumb.png"
    }
  ];
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(sampleProducts, null, 2));
}
if (!fs.existsSync(PAYMENTS_FILE)) fs.writeFileSync(PAYMENTS_FILE, JSON.stringify({}, null, 2));

function readProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
}
function readPayments() {
  return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
}
function writePayments(obj) {
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(obj, null, 2));
}

// API: list products
app.get('/api/products', (req, res) => {
  const prods = readProducts();
  res.json(prods);
});

// API: create Razorpay order (server-side)
app.post('/api/create-order', async (req, res) => {
  try {
    const { productId, buyerName, buyerEmail } = req.body;
    if (!productId) return res.status(400).json({ error: "Missing productId" });

    const products = readProducts();
    const product = products.find(p => p.id === productId);
    if (!product) return res.status(404).json({ error: "Product not found" });

    // Razorpay expects amount in paise
    const amountPaise = product.priceINR * 100;

    const options = {
      amount: amountPaise,
      currency: "INR",
      receipt: `rcpt_${product.id}_${Date.now()}`,
      payment_capture: 1 // auto-capture
    };

    const order = await razorpay.orders.create(options);

    // store a local pending record
    const payments = readPayments();
    payments[order.id] = {
      status: 'created',
      orderId: order.id,
      productId: product.id,
      productTitle: product.title,
      amountINR: product.priceINR,
      buyerName: buyerName || null,
      buyerEmail: buyerEmail || null,
      createdAt: Date.now()
    };
    writePayments(payments);

    res.json({ order });
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// API: verify payment after checkout (client calls this with Razorpay payment details)
app.post('/api/verify-payment', (req, res) => {
  /*
    Expected payload from client:
    {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    }
  */
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  // Verify signature using HMAC SHA256: hmac(order_id + "|" + payment_id, key_secret)
  const generated_signature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest('hex');

  if (generated_signature !== razorpay_signature) {
    console.warn("Signature mismatch", generated_signature, razorpay_signature);
    return res.status(400).json({ error: "Invalid signature" });
  }

  // mark payment as paid and generate a one-time download token
  const payments = readPayments();
  const local = payments[razorpay_order_id];
  if (!local) {
    return res.status(404).json({ error: "Order not found on server" });
  }

  // Create token
  const token = nanoid(32);
  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MIN * 60 * 1000;
  local.status = 'paid';
  local.razorpay_payment_id = razorpay_payment_id;
  local.razorpay_signature = razorpay_signature;
  local.downloadToken = token;
  local.downloadExpiresAt = expiresAt;

  payments[razorpay_order_id] = local;
  writePayments(payments);

  const product = readProducts().find(p => p.id === local.productId);
  const downloadUrl = `${BASE_URL}/download/${token}`;

  res.json({
    success: true,
    message: "Payment verified",
    downloadUrl,
    product: { id: product.id, title: product.title }
  });
});

// Download endpoint — validates token and serves file
app.get('/download/:token', (req, res) => {
  const token = req.params.token;
  const payments = readPayments();
  const orderEntry = Object.values(payments).find(p => p.downloadToken === token);

  if (!orderEntry) return res.status(404).send("Invalid or expired download link.");

  if (orderEntry.downloadExpiresAt < Date.now()) {
    return res.status(410).send("Download link has expired.");
  }

  // Optional: single-use — remove token after usage (uncomment if desired)
  // delete orderEntry.downloadToken; writePayments(payments);

  // find file
  const product = readProducts().find(p => p.id === orderEntry.productId);
  if (!product) return res.status(404).send("Product not found");

  const filePath = path.join(__dirname, 'downloads', product.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found on server");

  res.download(filePath, product.filename, err => {
    if (err) console.error("Error sending file:", err);
  });
});

// Simple admin route to view payments (for demo only)
// NOTE: remove or protect in production
app.get('/admin/payments', (req, res) => {
  const payments = readPayments();
  res.json(payments);
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Open ${BASE_URL} in browser`);
});
