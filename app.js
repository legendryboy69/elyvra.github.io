// public/app.js
async function fetchProducts() {
  const res = await fetch('/api/products');
  return res.json();
}

let PRODUCTS = [];
let CART = {};

function addToCart(productId) {
  CART[productId] = (CART[productId] || 0) + 1;
  renderCartCount();
}

function removeFromCart(productId) {
  delete CART[productId];
  renderCartCount();
}

function renderProducts() {
  const container = document.getElementById('products');
  container.innerHTML = '';
  PRODUCTS.forEach(p => {
    const card = document.createElement('div');
    card.className = 'card product';
    card.innerHTML = `
      <img src="${p.thumbnail || '/assets/placeholder.png'}" alt="${p.title}" />
      <div class="title">${p.title}</div>
      <div class="desc">${p.description}</div>
      <div class="price">₹ ${p.priceINR}</div>
      <div class="actions">
        <button class="btn" data-add="${p.id}">Add to cart</button>
        <button class="btn ghost" onclick="window.location.href='#'">Preview</button>
      </div>
    `;
    container.appendChild(card);
  });

  document.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      addToCart(btn.getAttribute('data-add'));
    });
  });
}

function renderCartCount() {
  const count = Object.values(CART).reduce((s,n)=>s+n,0);
  document.getElementById('cart-count').innerText = count;
}

function openCartPanel() {
  const panel = document.getElementById('checkout-panel');
  panel.classList.toggle('hidden');
  renderCartDetails();
}

function renderCartDetails() {
  const itemsContainer = document.getElementById('cart-items');
  itemsContainer.innerHTML = '';
  const totalEl = document.getElementById('cart-total');
  let total = 0;
  const productsMap = PRODUCTS.reduce((m,p)=>{m[p.id]=p;return m},{});
  for (let id in CART) {
    const qty = CART[id];
    const p = productsMap[id];
    if (!p) continue;
    total += p.priceINR * qty;
    const div = document.createElement('div');
    div.className='cart-item';
    div.innerHTML = `<div>${p.title} x ${qty}</div><div>₹ ${p.priceINR*qty}</div>`;
    itemsContainer.appendChild(div);
  }
  totalEl.innerText = total;
  document.getElementById('checkout-btn').disabled = total === 0;
}

async function init() {
  PRODUCTS = await fetchProducts();
  renderProducts();
  renderCartCount();
  document.getElementById('cart-btn').addEventListener('click', openCartPanel);
  document.getElementById('checkout-btn').addEventListener('click', onCheckout);
}

async function onCheckout() {
  // minimal validation
  const productIds = Object.keys(CART);
  if (productIds.length === 0) return alert('Cart empty');

  // For simplicity: support one product at a time — if multiple items, we create a composite "order" by summing price
  // We'll pick the first product ID as product for receipt (you can adapt to support multiple items)
  const productId = productIds[0];
  const buyerName = document.getElementById('buyerName').value;
  const buyerEmail = document.getElementById('buyerEmail').value;

  // create order server-side
  const createOrderRes = await fetch('/api/create-order', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ productId, buyerName, buyerEmail })
  });
  const data = await createOrderRes.json();
  if (!data.order) {
    return alert('Failed to create order');
  }
  const order = data.order;

  // configure Razorpay checkout options
  const options = {
    key: order.key_id || undefined, // we'll pass through in client
    name: "ELYVRA",
    description: "Purchase",
    order_id: order.id,
    theme: { color: "#111111" },
    handler: async function (response) {
      // verify on server
      const verify = await fetch('/api/verify-payment', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(response)
      });
      const result = await verify.json();
      if (result.success) {
        // show download link
        document.getElementById('download-link').href = result.downloadUrl;
        document.getElementById('download-panel').classList.remove('hidden');
        document.getElementById('checkout-panel').classList.add('hidden');
      } else {
        alert('Payment verification failed: ' + (result.error || 'Unknown'));
      }
    },
    modal: {
      ondismiss: function() {
        console.log('Checkout closed by user');
      }
    }
  };

  // Razorpay script expects 'key' in options (your key id). For security, we loaded an order id that Razorpay binds to keys on server.
  // Add the key id from server if provided (some SDKs do). But to be safe, client must have key id too for checkout.
  // You can expose your key id (not secret) in front-end. For demo we'll use the env key id via server injection; fallback to window variable.
  options.key = getRazorpayKeyId();
  const rzp = new Razorpay(options);
  rzp.open();
}

function getRazorpayKeyId() {
  // fallback: Razorpay key id must be placed inline or come from server; for demo, you can set window.RAZORPAY_KEY_ID in index if desired.
  // If not available, the checkout will still work if order_id maps to account and SDK can infer, but best to expose key_id (not secret).
  return window.RAZORPAY_KEY_ID || '';
}

window.onload = init;
