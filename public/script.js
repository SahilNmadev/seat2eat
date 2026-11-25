// ===== State =====
let MENU = [];        // menu comes from the server (managed on the counter dashboard)
let CATEGORIES = [];
let cart = {};        // { itemId: quantity }
let query = "";       // what the customer typed in the search box
let LATEST = null;    // this customer's most recent order
let lastSnapshot = ""; // used to skip re-drawing when nothing changed on the server

// ===== Helpers =====
const $ = id => document.getElementById(id);
const money = n => "₹" + n.toLocaleString("en-IN");
const slug = s => s.toLowerCase().replace(/\s+/g, "-");
const esc = s => String(s).replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const inStock = item => item.inStock !== false;

// The dismissed order is remembered per account, so two people sharing a browser do not see each other's status
const dismissKey = () => `set2eat.dismissed.${Store.session().id}`;

// Loads the menu and this customer's latest order. Redraws only if something changed.
async function loadAll(force = false) {
  const [menu, orders] = await Promise.all([Store.menu(), Store.myOrders()]);
  const snapshot = JSON.stringify([menu, orders]);
  if (!force && snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;

  MENU = menu;
  CATEGORIES = [...new Set(MENU.map(item => item.category))];
  LATEST = orders[0] || null;

  // Take items out of the cart if they were removed or went out of stock
  Object.keys(cart).forEach(id => {
    const item = MENU.find(m => m.id === Number(id));
    if (!item || !inStock(item)) delete cart[id];
  });

  renderCategories();
  refresh();
  renderStatus();
}

function cartTotal() {
  return Object.keys(cart).reduce((sum, id) => {
    const item = MENU.find(m => m.id === Number(id));
    return sum + item.price * cart[id];
  }, 0);
}
function cartCount() {
  return Object.values(cart).reduce((a, b) => a + b, 0);
}

// Photo, or a coloured tile with the first letter when there is no photo
function photoHtml(item) {
  return item.image
    ? `<img src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy">`
    : `<div class="photo-fallback" aria-hidden="true">${esc(item.name.charAt(0))}</div>`;
}

// ===== Category circles =====
function renderCategories() {
  $("category-row").innerHTML = CATEGORIES.map(category => {
    const withPhoto = MENU.find(i => i.category === category && i.image);
    const inner = withPhoto
      ? `<img src="${esc(withPhoto.image)}" alt="">`
      : `<span>${esc(category.charAt(0))}</span>`;
    return `
      <a class="cat" href="#cat-${slug(category)}">
        <span class="cat-img">${inner}</span>
        <span class="cat-name">${esc(category)}</span>
      </a>`;
  }).join("");
}

// ===== Menu cards =====
function actionHtml(item) {
  if (!inStock(item)) return `<span class="sold-out-label">Out of stock</span>`;
  const qty = cart[item.id] || 0;
  if (qty === 0) {
    return `<button class="add-btn" data-act="add" data-id="${item.id}">Add</button>`;
  }
  return `
    <div class="stepper">
      <button data-act="dec" data-id="${item.id}" aria-label="Remove one ${esc(item.name)}">−</button>
      <span>${qty}</span>
      <button data-act="add" data-id="${item.id}" aria-label="Add one ${esc(item.name)}">+</button>
    </div>`;
}

function cardHtml(item) {
  return `
    <li class="card ${inStock(item) ? "" : "is-out"}">
      <div class="card-media">
        <div class="card-photo">${photoHtml(item)}</div>
        <div class="card-action">${actionHtml(item)}</div>
      </div>
      <div class="card-body">
        <h3>${esc(item.name)}</h3>
        <p class="card-price">${money(item.price)}</p>
        ${item.desc ? `<p class="card-desc">${esc(item.desc)}</p>` : ""}
      </div>
    </li>`;
}

function renderMenu() {
  if (!MENU.length) {
    $("menu").innerHTML = '<p class="muted empty">No items are available right now.</p>';
    return;
  }

  const q = query.trim().toLowerCase();
  const matches = item => !q ||
    item.name.toLowerCase().includes(q) ||
    (item.desc || "").toLowerCase().includes(q) ||
    item.category.toLowerCase().includes(q);

  const sections = CATEGORIES.map(category => {
    const items = MENU.filter(item => item.category === category && matches(item));
    if (!items.length) return "";
    return `
      <section id="cat-${slug(category)}" class="menu-section">
        <h2>${esc(category)}</h2>
        <ul class="grid">${items.map(cardHtml).join("")}</ul>
      </section>`;
  }).join("");

  $("menu").innerHTML = sections ||
    `<p class="muted empty">Nothing matches “${esc(query.trim())}”. Try another word.</p>`;
}

// ===== Cart =====
function renderCart() {
  const ids = Object.keys(cart);

  $("cart-items").innerHTML = ids.map(id => {
    const item = MENU.find(m => m.id === Number(id));
    const qty = cart[id];
    return `
      <li class="cart-row">
        <span class="name">${esc(item.name)}</span>
        <span class="line-price">${money(item.price * qty)}</span>
        <div class="stepper">
          <button data-act="dec" data-id="${item.id}" aria-label="Remove one ${esc(item.name)}">−</button>
          <span>${qty}</span>
          <button data-act="add" data-id="${item.id}" aria-label="Add one ${esc(item.name)}">+</button>
        </div>
        <button class="remove-btn" data-act="remove" data-id="${item.id}">Remove</button>
      </li>`;
  }).join("");

  $("cart-empty").hidden = ids.length > 0;
  $("cart-total").textContent = money(cartTotal());
  $("checkout-btn").disabled = ids.length === 0;

  const count = cartCount();
  $("cart-count").textContent = count;
  $("cart-count").hidden = count === 0;
}

function refresh() {
  renderMenu();
  renderCart();
}

function handleCartClick(event) {
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);

  if (btn.dataset.act === "add") cart[id] = Math.min((cart[id] || 0) + 1, 20); // server allows 20 per item
  if (btn.dataset.act === "dec") {
    cart[id] = (cart[id] || 0) - 1;
    if (cart[id] <= 0) delete cart[id];
  }
  if (btn.dataset.act === "remove") delete cart[id];

  refresh();
}
$("menu").addEventListener("click", handleCartClick);
$("cart-items").addEventListener("click", handleCartClick);

$("search").addEventListener("input", event => {
  query = event.target.value;
  renderMenu();
});

// ===== Checkout =====
const dialog = $("checkout-dialog");
const form = $("checkout-form");

$("checkout-btn").addEventListener("click", () => {
  $("dialog-total").textContent = money(cartTotal());
  $("checkout-error").textContent = "";
  dialog.showModal();
});
$("cancel-checkout").addEventListener("click", () => dialog.close());

form.addEventListener("change", () => {
  const method = form.elements.payment.value;
  $("pay-note").hidden = method !== "Online";
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("place-order");
  button.disabled = true;
  $("checkout-error").textContent = "";

  try {
    // Only ids and quantities are sent. The server looks up the real prices.
    await Store.placeOrder({
      row: form.elements.row.value.trim().toUpperCase(),
      seat: form.elements.seat.value.trim(),
      payment: form.elements.payment.value,
      items: Object.keys(cart).map(id => ({ id: Number(id), qty: cart[id] }))
    });

    cart = {};
    form.reset();
    $("pay-note").hidden = true;
    dialog.close();
    await loadAll(true);
  } catch (err) {
    $("checkout-error").textContent = err.message;
    loadAll(true).catch(() => {}); // the menu may have changed (item sold out), so refresh it
  } finally {
    button.disabled = false;
  }
});

// ===== Live order status =====
const STATUS_TEXT = {
  pending:   "Waiting for the counter to confirm your order.",
  accepted:  "Accepted. Your order is being prepared and will be brought to your seat.",
  rejected:  "Sorry, the counter could not accept this order. Please try again or visit the counter.",
  delivered: "Delivered. Enjoy the show."
};
const STATUS_LABEL = {
  pending: "Pending", accepted: "Accepted", rejected: "Rejected", delivered: "Delivered"
};

function renderStatus() {
  const box = $("order-status");
  const order = LATEST;

  if (!order || String(order.id) === localStorage.getItem(dismissKey())) { box.innerHTML = ""; return; }

  const finished = order.status === "rejected" || order.status === "delivered";
  box.innerHTML = `
    <div class="status">
      <div class="status-top">
        <span class="status-title">Order #${order.id}</span>
        <span class="badge badge-${order.status}">${STATUS_LABEL[order.status]}</span>
      </div>
      <p class="status-seat">Row ${esc(order.row)}, Seat ${esc(order.seat)}, ${esc(order.payment)}</p>
      <p class="status-note">${STATUS_TEXT[order.status]}</p>
      ${finished ? '<button class="btn btn-outline" id="dismiss-status">Dismiss</button>' : ""}
    </div>`;

  const dismiss = $("dismiss-status");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      localStorage.setItem(dismissKey(), String(order.id));
      renderStatus();
    });
  }
}

// ===== Account =====
$("logout-btn").addEventListener("click", () => Store.logout());

// ===== Start =====
(async function start() {
  if (!Store.requireLogin()) return;
  try {
    const me = await Store.me(); // also confirms the saved login is still valid
    $("account-name").textContent = me.name;
    await loadAll(true);
    Store.poll(() => loadAll(), 5000); // pick up counter updates and menu changes
  } catch (err) {
    $("menu").innerHTML = `<p class="muted empty">${esc(err.message)}</p>`;
  }
})();