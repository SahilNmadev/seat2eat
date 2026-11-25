// ===== Helpers =====
const $ = id => document.getElementById(id);
const money = n => "₹" + Number(n).toLocaleString("en-IN");
const esc = s => String(s).replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const timeOf = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const STATUS_LABEL = {
  pending: "Pending", accepted: "Accepted", rejected: "Rejected", delivered: "Delivered"
};

// ===== State =====
let activeTab = "pending";
let ORDERS = [];             // all orders, from the server
let MENU = [];               // the menu, from the server
let lastSnapshot = "";       // skip re-drawing when nothing changed
const dismissed = new Set(); // orders whose pop-up was already shown and closed
let ignoreNextClose = false; // true when the script itself closes the pop-up

// Which tab does each order belong to?
function tabOf(order) {
  if (order.status === "pending") return "pending";
  if (order.status === "accepted") return "accepted";
  return "history"; // rejected or delivered
}

// Loads orders and menu from the server. Redraws only if something changed.
async function load() {
  const [orders, menu] = await Promise.all([Store.orders(), Store.menu()]);
  const snapshot = JSON.stringify([orders, menu]);
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  ORDERS = orders;
  MENU = menu;
  render();
}

// ===== Order list =====
function itemsHtml(items) {
  return items.map(i => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${money(i.qty * i.price)}</span></li>`).join("");
}

function customerLine(order) {
  const c = order.customer;
  return esc(c.name) + (c.phone ? " · " + esc(c.phone) : "");
}

function actionsHtml(order) {
  if (order.status === "pending") {
    return `
      <button class="btn btn-outline" data-act="rejected" data-id="${order.id}">Reject</button>
      <button class="btn btn-primary" data-act="accepted" data-id="${order.id}">Accept</button>`;
  }
  if (order.status === "accepted") {
    return `<button class="btn btn-primary" data-act="delivered" data-id="${order.id}">Mark as delivered</button>`;
  }
  return "";
}

function renderList(orders) {
  const list = orders.filter(o => tabOf(o) === activeTab);

  // Pending: oldest first (serve in order). Others: newest first.
  list.sort((a, b) => activeTab === "pending" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);

  $("orders").innerHTML = list.map(order => `
    <li class="order-card">
      <div class="order-head">
        <span class="order-id">Order #${order.id}</span>
        <span class="badge badge-${order.status}">${STATUS_LABEL[order.status]}</span>
      </div>
      <p class="order-seat">Row ${esc(order.row)} · Seat ${esc(order.seat)}</p>
      <p class="order-customer">${customerLine(order)}</p>
      <p class="order-meta">${timeOf(order.createdAt)} · ${esc(order.payment)}</p>
      <ul class="item-list">${itemsHtml(order.items)}</ul>
      <div class="total-row"><span>Total</span><strong>${money(order.total)}</strong></div>
      <div class="order-actions">${actionsHtml(order)}</div>
    </li>`).join("");

  const emptyText = {
    pending: "No new orders right now. New orders will pop up here.",
    accepted: "No accepted orders waiting for delivery.",
    history: "No completed or rejected orders yet."
  };
  $("orders-empty").textContent = list.length ? "" : emptyText[activeTab];
}

function renderCounts(orders) {
  const counts = { pending: 0, accepted: 0, history: 0 };
  orders.forEach(o => counts[tabOf(o)]++);
  $("count-pending").textContent = counts.pending;
  $("count-accepted").textContent = counts.accepted;
  $("count-history").textContent = counts.history;
  $("count-menu").textContent = MENU.length;
  document.title = (counts.pending ? `(${counts.pending}) ` : "") + "Counter Dashboard | Interval";
}

// ===== New order pop-up =====
const alertDialog = $("alert-dialog");

function beep() {
  // Short alert sound. Browsers may block it until you click on the page once.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (err) { /* ignore */ }
}

function renderPopup(orders) {
  // If a pop-up is open but that order is no longer pending, close it
  if (alertDialog.open) {
    const current = orders.find(o => o.id === Number(alertDialog.dataset.orderId));
    if (current && current.status === "pending") return; // keep showing it
    ignoreNextClose = true;
    alertDialog.close();
  }

  const next = orders
    .filter(o => o.status === "pending" && !dismissed.has(o.id))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;

  alertDialog.dataset.orderId = next.id;
  $("alert-title").textContent = `Order #${next.id}`;
  $("alert-seat").textContent = `Row ${next.row} · Seat ${next.seat}`;
  $("alert-customer").textContent = next.customer.name + (next.customer.phone ? " · " + next.customer.phone : "");
  $("alert-items").innerHTML = itemsHtml(next.items);
  $("alert-payment").textContent = next.payment;
  $("alert-total").textContent = money(next.total);
  alertDialog.showModal();
  beep();
}

function popupOrderId() {
  return Number(alertDialog.dataset.orderId);
}

// Accept / reject from the pop-up
async function decide(status) {
  const id = popupOrderId();
  try {
    await Store.setStatus(id, status);
  } catch (err) {
    alert(err.message); // for example: another counter already handled this order
    await load().catch(() => {});
    return;
  }
  alertDialog.close();
  await load();
}
$("alert-accept").addEventListener("click", () => decide("accepted"));
$("alert-reject").addEventListener("click", () => decide("rejected"));
$("alert-later").addEventListener("click", () => alertDialog.close());

// Whenever the pop-up closes (button or Esc key), move on to the next order
alertDialog.addEventListener("close", () => {
  if (ignoreNextClose) { ignoreNextClose = false; return; }
  dismissed.add(popupOrderId());
  render();
});

// ===== Buttons on the order cards =====
$("orders").addEventListener("click", async event => {
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  btn.disabled = true;
  try {
    await Store.setStatus(Number(btn.dataset.id), btn.dataset.act);
  } catch (err) {
    alert(err.message);
  }
  await load().catch(() => {});
});

// ===== Menu manager =====
let newPhoto = ""; // photo chosen in the "Add an item" form (data URL)

function itemCard(item) {
  const out = item.inStock === false;
  const photo = item.image
    ? `<img src="${esc(item.image)}" alt="${esc(item.name)}">`
    : `<div class="photo-fallback" aria-hidden="true">${esc(item.name.charAt(0))}</div>`;

  return `
    <li class="m-card ${out ? "is-out" : ""}">
      <div class="m-photo">${photo}</div>
      <div class="m-body">
        <div class="m-top">
          <h3>${esc(item.name)}</h3>
          <span class="price">${money(item.price)}</span>
        </div>
        ${item.desc ? `<p class="m-desc">${esc(item.desc)}</p>` : ""}
        ${out ? '<p><span class="badge badge-rejected">Out of stock</span></p>' : ""}

        <div class="m-actions">
          <button type="button" class="btn btn-outline btn-small" data-stock="${item.id}">${out ? "Back in stock" : "Mark out of stock"}</button>
        </div>
        <div class="m-actions">
          <label class="link-btn">${item.image ? "Change photo" : "Add photo"}
            <input type="file" accept="image/*" data-photo="${item.id}" hidden>
          </label>
          ${item.image ? `<button type="button" class="link-btn" data-clear-photo="${item.id}">Remove photo</button>` : ""}
          <button type="button" class="link-btn" data-remove="${item.id}">Remove item</button>
        </div>
      </div>
    </li>`;
}

function renderMenuManager() {
  const categories = [...new Set(MENU.map(item => item.category))];

  $("category-list").innerHTML = categories.map(c => `<option value="${esc(c)}"></option>`).join("");

  if (!MENU.length) {
    $("menu-list").innerHTML = '<p class="muted empty">The menu is empty. Add your first item above.</p>';
    return;
  }

  $("menu-list").innerHTML = categories.map(category => `
    <section class="menu-section">
      <h2>${esc(category)}</h2>
      <ul class="menu-grid">
        ${MENU.filter(item => item.category === category).map(itemCard).join("")}
      </ul>
    </section>`).join("");
}

// Photo chosen in the "Add an item" form
function setNewPhoto(dataUrl) {
  newPhoto = dataUrl;
  $("photo-preview").src = dataUrl;
  $("photo-preview").hidden = !dataUrl;
  $("photo-hint").hidden = !!dataUrl;
  $("photo-clear").hidden = !dataUrl;
}

$("item-photo").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    setNewPhoto(await Store.readImage(file));
    $("menu-message").textContent = "";
  } catch (err) {
    $("menu-message").textContent = err.message;
  }
  event.target.value = ""; // allows choosing the same file again
});
$("photo-clear").addEventListener("click", () => setNewPhoto(""));

$("item-form").addEventListener("submit", async event => {
  event.preventDefault();
  const itemForm = event.target;
  const name = $("item-name").value.trim();
  const category = $("item-category").value.trim();
  const price = Math.round(Number($("item-price").value));
  if (!name || !category || !(price > 0)) return;

  try {
    await Store.addMenuItem({ name, category, price, desc: $("item-desc").value.trim(), image: newPhoto });
    itemForm.reset();
    setNewPhoto("");
    $("item-name").focus();
    $("menu-message").textContent = `"${name}" added. Customers will see it within a few seconds.`;
    await load();
  } catch (err) {
    $("menu-message").textContent = err.message;
  }
});

// "Change photo" on an item
$("menu-list").addEventListener("change", async event => {
  const field = event.target;
  if (!field.dataset.photo || !field.files[0]) return;
  try {
    const image = await Store.readImage(field.files[0]);
    await Store.updateMenuItem(Number(field.dataset.photo), { image });
    $("menu-message").textContent = "Photo updated.";
    await load();
  } catch (err) {
    $("menu-message").textContent = err.message;
  }
});

// Mark out of stock / Back in stock / Remove photo / Remove item
$("menu-list").addEventListener("click", async event => {
  const stockBtn = event.target.closest("[data-stock]");
  if (stockBtn) {
    const item = MENU.find(m => m.id === Number(stockBtn.dataset.stock));
    if (!item) return;
    const makeAvailable = item.inStock === false;
    stockBtn.disabled = true;
    try {
      await Store.updateMenuItem(item.id, { inStock: makeAvailable });
      $("menu-message").textContent = makeAvailable
        ? `"${item.name}" is back in stock.`
        : `"${item.name}" is now out of stock. Customers cannot order it.`;
      await load();
    } catch (err) {
      $("menu-message").textContent = err.message;
      stockBtn.disabled = false;
    }
    return;
  }

  const clearBtn = event.target.closest("[data-clear-photo]");
  if (clearBtn) {
    try {
      await Store.updateMenuItem(Number(clearBtn.dataset.clearPhoto), { image: "" });
      $("menu-message").textContent = "Photo removed.";
      await load();
    } catch (err) {
      $("menu-message").textContent = err.message;
    }
    return;
  }

  const btn = event.target.closest("[data-remove]");
  if (!btn) return;
  const item = MENU.find(m => m.id === Number(btn.dataset.remove));
  if (!item) return;
  if (!confirm(`Remove "${item.name}" from the menu?`)) return;

  try {
    await Store.removeMenuItem(item.id);
    $("menu-message").textContent = `"${item.name}" removed.`;
    await load();
  } catch (err) {
    $("menu-message").textContent = err.message;
  }
});

// ===== Tabs =====
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
    render();
  });
});

// ===== Sales analytics =====
let salesRange = 7; // days: 7 = 1 week, 30 = 1 month, 365 = 1 year
const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = n => String(n).padStart(2, "0");
const dateKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const monthKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };

// Sales = accepted + delivered orders inside the chosen time range
function salesOrders(orders) {
  const since = Date.now() - salesRange * DAY_MS;
  return orders.filter(o => (o.status === "accepted" || o.status === "delivered") && o.createdAt >= since);
}

function renderSales(orders) {
  const sales = salesOrders(orders);
  const revenue = sales.reduce((sum, o) => sum + o.total, 0);
  const itemsSold = sales.reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.qty, 0), 0);

  $("stat-orders").textContent = sales.length;
  $("stat-revenue").textContent = money(revenue);
  $("stat-avg").textContent = money(sales.length ? Math.round(revenue / sales.length) : 0);
  $("stat-items").textContent = itemsSold;

  // Breakdown: per day for week/month, per month for year
  const byMonth = salesRange === 365;
  $("breakdown-title").textContent = byMonth ? "Monthly sales" : "Daily sales";
  const groups = {};
  sales.forEach(o => {
    const key = byMonth ? monthKey(o.createdAt) : dateKey(o.createdAt);
    groups[key] = groups[key] || { orders: 0, revenue: 0 };
    groups[key].orders++;
    groups[key].revenue += o.total;
  });
  const keys = Object.keys(groups).sort().reverse();
  $("sales-breakdown").innerHTML = keys.length
    ? `<table class="sales-table">
         <thead><tr><th>${byMonth ? "Month" : "Date"}</th><th>Orders</th><th>Revenue</th></tr></thead>
         <tbody>${keys.map(k => `<tr><td>${k}</td><td>${groups[k].orders}</td><td>${money(groups[k].revenue)}</td></tr>`).join("")}</tbody>
       </table>`
    : '<p class="muted">No sales in this period yet.</p>';

  // Top items by quantity
  const totals = {};
  sales.forEach(o => o.items.forEach(i => {
    totals[i.name] = totals[i.name] || { qty: 0, revenue: 0 };
    totals[i.name].qty += i.qty;
    totals[i.name].revenue += i.qty * i.price;
  }));
  const top = Object.entries(totals).sort((a, b) => b[1].qty - a[1].qty).slice(0, 8);
  $("sales-top").innerHTML = top.length
    ? `<table class="sales-table">
         <thead><tr><th>Item</th><th>Qty</th><th>Revenue</th></tr></thead>
         <tbody>${top.map(([name, t]) => `<tr><td>${esc(name)}</td><td>${t.qty}</td><td>${money(t.revenue)}</td></tr>`).join("")}</tbody>
       </table>`
    : '<p class="muted">No items sold in this period yet.</p>';
}

// The CSV files are built on the server (they include customer account details)
async function downloadCsv(type, button) {
  button.disabled = true;
  try {
    await Store.downloadCsv(type, salesRange);
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}
$("download-csv").addEventListener("click", event => downloadCsv("orders", event.currentTarget));
$("download-customers-csv").addEventListener("click", event => downloadCsv("customers", event.currentTarget));

document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    salesRange = Number(btn.dataset.range);
    document.querySelectorAll(".range-btn").forEach(b => b.classList.toggle("active", b === btn));
    render();
  });
});

// ===== Render everything =====
function render() {
  renderCounts(ORDERS);

  const showMenu = activeTab === "menu";
  const showSales = activeTab === "sales";
  $("menu-manager").hidden = !showMenu;
  $("sales-panel").hidden = !showSales;
  $("orders").hidden = showMenu || showSales;
  $("orders-empty").hidden = showMenu || showSales;
  if (showMenu) renderMenuManager();
  else if (showSales) renderSales(ORDERS);
  else renderList(ORDERS);

  renderPopup(ORDERS);
}

// ===== Account =====
$("logout-btn").addEventListener("click", () => Store.logout());

// ===== Start =====
(async function start() {
  if (!Store.requireLogin()) return;
  const me = Store.session();
  $("account-name").textContent = me.name || me.username;
  try {
    await load();
  } catch (err) {
    $("orders-empty").textContent = err.message;
  }
  Store.poll(load, 4000); // new orders from customers show up within a few seconds
})();