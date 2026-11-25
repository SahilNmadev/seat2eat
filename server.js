// Set2eat backend: Express + SQLite (two separate database files)
//
// Run (PowerShell):  npm install
//                    $env:ADMIN_PASSWORD="yourpass"; $env:ADMIN_SIGNUP_CODE="staff-code"; node server.js
// Run (Mac/Linux):   ADMIN_PASSWORD=yourpass ADMIN_SIGNUP_CODE=staff-code node server.js
//
// Two kinds of accounts, completely separate:
//   customers -> users table,  sign up at /login.html        (anyone can register)
//   counter   -> admins table, sign up at /admin-login.html  (needs the staff code)
const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

// Reads settings.env (the file next to server.js) so you never have to type passwords in the terminal.
(function loadSettings() {
  const file = path.join(__dirname, "settings.env");
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
})();

// The database files always live next to server.js, wherever you start the server from.
const counter = new Database(path.join(__dirname, "counter.db")); // accounts, menu, orders, sales
const seat = new Database(path.join(__dirname, "seat.db"));       // "Delivered to your seat": ratings, hero, chat log

counter.exec(`
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '', salt TEXT, hash TEXT, created_at INTEGER, last_login_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, role TEXT, account_id INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS menu(id INTEGER PRIMARY KEY, category TEXT, name TEXT, desc TEXT DEFAULT '',
  price INTEGER, image TEXT DEFAULT '', in_stock INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT 'pending',
  row TEXT, seat TEXT, payment TEXT, total INTEGER,
  created_at INTEGER, delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER, item_id INTEGER, name TEXT, qty INTEGER, price INTEGER);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
`);

// Upgrade a database created by the older version of this file
function addColumn(db, table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn(counter, "admins", "name", "TEXT DEFAULT ''");
addColumn(counter, "admins", "created_at", "INTEGER");
addColumn(counter, "admins", "last_login_at", "INTEGER");
addColumn(counter, "orders", "user_id", "INTEGER"); // old orders stay NULL = "guest"
counter.exec("CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)");

seat.exec(`
CREATE TABLE IF NOT EXISTS ratings(id INTEGER PRIMARY KEY, order_id INTEGER, item_id INTEGER,
  stars INTEGER CHECK(stars BETWEEN 1 AND 5), created_at INTEGER, UNIQUE(order_id, item_id));
CREATE TABLE IF NOT EXISTS hero(id INTEGER PRIMARY KEY CHECK(id=1), image TEXT DEFAULT '', title TEXT, subtitle TEXT);
INSERT OR IGNORE INTO hero(id,title,subtitle) VALUES(1,'Snacks at your seat','Order now, we bring it to you');
CREATE TABLE IF NOT EXISTS chat_log(id INTEGER PRIMARY KEY, role TEXT, text TEXT, created_at INTEGER);
`);

// ---------- Passwords (scrypt, per-account salt) ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
function makePw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPw(pw, salt) };
}
function checkPw(pw, salt, hash) {
  const a = Buffer.from(hashPw(pw, salt), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // constant-time string compare

// First run: create the starting counter account (username "admin")
if (!counter.prepare("SELECT 1 FROM admins").get()) {
  if (!process.env.ADMIN_PASSWORD) console.warn("WARNING: ADMIN_PASSWORD not set. The first admin password is 'change-me'. Change it.");
  const { salt, hash } = makePw(process.env.ADMIN_PASSWORD || "change-me");
  counter.prepare("INSERT INTO admins(username,name,salt,hash,created_at) VALUES(?,?,?,?,?)")
    .run("admin", "Counter admin", salt, hash, Date.now());
}

// ---------- Sessions (only a hash of each token is stored) ----------
const SESSION_MS = 12 * 3600 * 1000;
function newSession(role, accountId) {
  const token = crypto.randomBytes(32).toString("hex");
  counter.prepare("INSERT INTO sessions(token_hash,role,account_id,expires_at) VALUES(?,?,?,?)")
    .run(sha(token).toString("hex"), role, accountId, Date.now() + SESSION_MS);
  return token;
}
const purgeSessions = () => counter.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
purgeSessions();
setInterval(purgeSessions, 3600 * 1000).unref();

// A customer token only works on customer routes, an admin token only on admin routes
function auth(role) {
  return (req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const s = token && counter.prepare("SELECT * FROM sessions WHERE token_hash=? AND role=? AND expires_at>?")
      .get(sha(token).toString("hex"), role, Date.now());
    const account = s && counter.prepare(
      role === "admin" ? "SELECT id,username,name FROM admins WHERE id=?" : "SELECT id,name,email,phone FROM users WHERE id=?"
    ).get(s.account_id);
    if (!account) return res.status(401).json({ error: "Please log in" });
    req.account = account;
    req.token = token;
    next();
  };
}
const needUser = auth("customer");
const needAdmin = auth("admin");
const endSession = (req, res) => {
  counter.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(req.token).toString("hex"));
  res.json({ ok: true });
};

// ---------- Brute-force protection: 8 failed attempts, then 15 minutes locked ----------
const fails = new Map();
const isLocked = key => { const f = fails.get(key); return !!f && f.until > Date.now() && f.n >= 8; };
function addFail(key) {
  let f = fails.get(key);
  if (!f || f.until <= Date.now()) f = { n: 0, until: Date.now() + 15 * 60 * 1000 };
  f.n++;
  fails.set(key, f);
}
const TOO_MANY = { error: "Too many attempts. Please wait 15 minutes and try again." };

// ---------- Input checks ----------
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+\-\s]{7,15}$/;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const passwordProblem = pw =>
  pw.length < 8 ? "Password must be at least 8 characters." : pw.length > 200 ? "Password is too long." : null;

const app = express();
app.use(express.json({ limit: "15mb" })); // photos are base64
const PUBLIC = path.join(__dirname, "public");
app.use(express.static(PUBLIC));
app.get("/admin", (req, res) => res.redirect("/admin.html"));

// =====================================================================
//  CUSTOMER ACCOUNTS
// =====================================================================
app.post("/api/auth/signup", (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const phone = clean(req.body.phone, 15);
  const pw = String(req.body.password || "");

  if (name.length < 2) return bad(res, "Please enter your name.");
  if (!EMAIL.test(email)) return bad(res, "Please enter a valid email address.");
  if (phone && !PHONE.test(phone)) return bad(res, "Phone number can only have digits, spaces, + and -.");
  if (passwordProblem(pw)) return bad(res, passwordProblem(pw));

  const taken = () => bad(res, "An account with this email already exists. Please log in.", 409);
  if (counter.prepare("SELECT 1 FROM users WHERE email=?").get(email)) return taken();

  const { salt, hash } = makePw(pw);
  const now = Date.now();
  let id;
  try {
    id = counter.prepare("INSERT INTO users(name,email,phone,salt,hash,created_at,last_login_at) VALUES(?,?,?,?,?,?,?)")
      .run(name, email, phone, salt, hash, now, now).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE|CONSTRAINT/i.test(`${e.code} ${e.message}`)) return taken(); // two sign-ups at the same instant
    throw e;
  }
  res.json({ token: newSession("customer", id), user: { id: Number(id), name, email, phone } });
});

app.post("/api/auth/login", (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const pw = String(req.body.password || "");
  const key = `c|${req.ip}|${email}`;
  if (isLocked(key)) return res.status(429).json(TOO_MANY);

  const u = counter.prepare("SELECT * FROM users WHERE email=?").get(email);
  const ok = u ? checkPw(pw, u.salt, u.hash) : (hashPw(pw, "x"), false); // same work either way
  if (!ok) { addFail(key); return bad(res, "Wrong email or password.", 401); }

  fails.delete(key);
  counter.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(Date.now(), u.id);
  res.json({ token: newSession("customer", u.id), user: { id: u.id, name: u.name, email: u.email, phone: u.phone } });
});

app.get("/api/auth/me", needUser, (req, res) => res.json({ user: req.account }));
app.post("/api/auth/logout", needUser, endSession);

// =====================================================================
//  COUNTER (ADMIN) ACCOUNTS
// =====================================================================
app.post("/api/admin/auth/signup", (req, res) => {
  const staffCode = process.env.ADMIN_SIGNUP_CODE;
  if (!staffCode) return bad(res, "Counter sign-up is switched off because no staff code is set. Open settings.env, set ADMIN_SIGNUP_CODE, then restart the server.", 403);

  const key = `a-signup|${req.ip}`;
  if (isLocked(key)) return res.status(429).json(TOO_MANY);
  if (!same(String(req.body.adminCode || ""), staffCode)) { addFail(key); return bad(res, "Wrong staff code.", 403); }

  const name = clean(req.body.name, 60);
  const username = clean(req.body.username, 30).toLowerCase();
  const pw = String(req.body.password || "");
  if (name.length < 2) return bad(res, "Please enter your name.");
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) return bad(res, "Username: 3 to 30 letters, numbers, dots or underscores.");
  if (passwordProblem(pw)) return bad(res, passwordProblem(pw));

  const taken = () => bad(res, "That username is taken.", 409);
  if (counter.prepare("SELECT 1 FROM admins WHERE username=?").get(username)) return taken();

  const { salt, hash } = makePw(pw);
  const now = Date.now();
  let id;
  try {
    id = counter.prepare("INSERT INTO admins(username,name,salt,hash,created_at,last_login_at) VALUES(?,?,?,?,?,?)")
      .run(username, name, salt, hash, now, now).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE|CONSTRAINT/i.test(`${e.code} ${e.message}`)) return taken();
    throw e;
  }
  res.json({ token: newSession("admin", id), user: { id: Number(id), name, username } });
});

app.post("/api/admin/auth/login", (req, res) => {
  const username = clean(req.body.username, 30).toLowerCase();
  const pw = String(req.body.password || "");
  const key = `a|${req.ip}|${username}`;
  if (isLocked(key)) return res.status(429).json(TOO_MANY);

  const a = counter.prepare("SELECT * FROM admins WHERE username=?").get(username);
  const ok = a ? checkPw(pw, a.salt, a.hash) : (hashPw(pw, "x"), false);
  if (!ok) { addFail(key); return bad(res, "Wrong username or password.", 401); }

  fails.delete(key);
  counter.prepare("UPDATE admins SET last_login_at=? WHERE id=?").run(Date.now(), a.id);
  res.json({ token: newSession("admin", a.id), user: { id: a.id, name: a.name || a.username, username: a.username } });
});

app.get("/api/admin/auth/me", needAdmin, (req, res) => res.json({ user: req.account }));
app.post("/api/admin/auth/logout", needAdmin, endSession);

// =====================================================================
//  MENU (public to read, admin to change)
// =====================================================================
app.get("/api/menu", (req, res) => {
  const rows = counter.prepare("SELECT * FROM menu").all();
  const r = {};
  seat.prepare("SELECT item_id, ROUND(AVG(stars),1) avg, COUNT(*) n FROM ratings GROUP BY item_id")
    .all().forEach(x => (r[x.item_id] = x));
  res.json(rows.map(m => ({ ...m, inStock: !!m.in_stock, rating: r[m.id]?.avg || null, ratingCount: r[m.id]?.n || 0 })));
});
app.post("/api/admin/menu", needAdmin, (req, res) => {
  const category = clean(req.body.category, 24);
  const name = clean(req.body.name, 40);
  const desc = clean(req.body.desc, 70);
  const price = Number(req.body.price);
  const image = typeof req.body.image === "string" ? req.body.image : "";
  if (!category || !name || !Number.isInteger(price) || price < 1) return bad(res, "Name, category and a whole-rupee price are required.");
  const info = counter.prepare("INSERT INTO menu(category,name,desc,price,image) VALUES(?,?,?,?,?)")
    .run(category, name, desc, price, image);
  res.json({ id: Number(info.lastInsertRowid) });
});
// Edit any field, including description
app.patch("/api/admin/menu/:id", needAdmin, (req, res) => {
  const ok = { name: "name", desc: "desc", price: "price", image: "image", category: "category", inStock: "in_stock" };
  for (const [k, col] of Object.entries(ok))
    if (k in req.body)
      counter.prepare(`UPDATE menu SET ${col}=? WHERE id=?`).run(k === "inStock" ? +req.body[k] : req.body[k], req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/menu/:id", needAdmin, (req, res) => {
  counter.prepare("DELETE FROM menu WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
// One-time: moves your existing browser menu (with your photos) into SQL, unchanged.
// In the old dashboard console run: copy(localStorage.getItem("interval.menu"))
app.post("/api/admin/import-menu", needAdmin, (req, res) => {
  const ins = counter.prepare(
    "INSERT OR REPLACE INTO menu(id,category,name,desc,price,image,in_stock) VALUES(?,?,?,?,?,?,?)");
  counter.transaction(list => list.forEach(m =>
    ins.run(m.id, m.category, m.name, m.desc || "", m.price, m.image || "", m.inStock === false ? 0 : 1)))(req.body);
  res.json({ imported: req.body.length });
});

// =====================================================================
//  ORDERS
// =====================================================================
const itemsOf = counter.prepare("SELECT item_id,name,qty,price FROM order_items WHERE order_id=?");
const shape = o => ({
  id: o.id, status: o.status, row: o.row, seat: o.seat, payment: o.payment, total: o.total,
  createdAt: o.created_at, deliveredAt: o.delivered_at, items: itemsOf.all(o.id)
});

// Place an order (customer must be logged in; prices always come from the database)
app.post("/api/orders", needUser, (req, res) => {
  const row = clean(req.body.row, 3).toUpperCase();
  const s = clean(req.body.seat, 3);
  const payment = req.body.payment;
  if (!/^[A-Z0-9]{1,3}$/.test(row) || !/^[0-9]{1,3}$/.test(s)) return bad(res, "Please enter a valid row and seat number.");
  if (!["Online", "Cash on delivery"].includes(payment)) return bad(res, "Please choose a payment method.");

  const wanted = new Map(); // item id -> quantity (duplicates merged)
  for (const i of Array.isArray(req.body.items) ? req.body.items : []) {
    const id = Number(i.id), qty = Number(i.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) return bad(res, "Invalid item in your cart.");
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (!wanted.size) return bad(res, "Your cart is empty.");

  const get = counter.prepare("SELECT * FROM menu WHERE id=? AND in_stock=1");
  let total = 0;
  const lines = [];
  for (const [id, qty] of wanted) {
    const m = get.get(id);
    if (!m) return bad(res, "An item in your cart is no longer available. Please check your cart.");
    if (qty > 20) return bad(res, `You can order at most 20 of ${m.name}.`);
    total += m.price * qty;
    lines.push({ ...m, qty });
  }

  const id = counter.transaction(() => {
    const o = counter.prepare("INSERT INTO orders(user_id,row,seat,payment,total,created_at) VALUES(?,?,?,?,?,?)")
      .run(req.account.id, row, s, payment, total, Date.now()).lastInsertRowid;
    lines.forEach(l => counter.prepare("INSERT INTO order_items VALUES(?,?,?,?,?)").run(o, l.id, l.name, l.qty, l.price));
    return o;
  })();
  res.json({ id: Number(id) });
});

// The logged-in customer's own orders, newest first
app.get("/api/orders/mine", needUser, (req, res) => {
  const rated = seat.prepare("SELECT item_id FROM ratings WHERE order_id=?");
  const os = counter.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.account.id);
  res.json(os.map(o => ({ ...shape(o), rated: rated.all(o.id).map(r => r.item_id) })));
});
app.get("/api/orders/:id", needUser, (req, res) => { // customers can only see their own orders
  const o = counter.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(req.params.id, req.account.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  res.json({ ...shape(o), rated: seat.prepare("SELECT item_id FROM ratings WHERE order_id=?").all(o.id).map(r => r.item_id) });
});

app.get("/api/admin/orders", needAdmin, (req, res) => {
  const os = counter.prepare(`
    SELECT o.*, u.name cname, u.email cemail, u.phone cphone
    FROM orders o LEFT JOIN users u ON u.id=o.user_id
    ORDER BY o.created_at DESC`).all();
  res.json(os.map(o => ({
    ...shape(o),
    userId: o.user_id,
    customer: { name: o.cname || "Guest (no account)", email: o.cemail || "", phone: o.cphone || "" }
  })));
});
// pending -> accepted | rejected,  accepted -> delivered
app.patch("/api/admin/orders/:id", needAdmin, (req, res) => {
  const st = req.body.status;
  const o = counter.prepare("SELECT status FROM orders WHERE id=?").get(req.params.id);
  if (!o) return bad(res, "Order not found.", 404);
  const next = { pending: ["accepted", "rejected"], accepted: ["delivered"] }[o.status] || [];
  if (!next.includes(st)) return bad(res, `This order is already ${o.status}.`, 409);
  counter.prepare("UPDATE orders SET status=?, delivered_at=CASE WHEN ?='delivered' THEN ? END WHERE id=?")
    .run(st, st, Date.now(), req.params.id);
  res.json({ ok: true });
});

// ---- Sales report (JSON): ?by=day|hour&from=YYYY-MM-DD&to=YYYY-MM-DD ----
app.get("/api/admin/sales", needAdmin, (req, res) => {
  const fmt = req.query.by === "hour" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
  const from = req.query.from ? Date.parse(req.query.from) : 0;
  const to = req.query.to ? Date.parse(req.query.to) + 86400000 : Date.now() + 86400000;
  res.json(counter.prepare(`
    SELECT strftime('${fmt}', created_at/1000, 'unixepoch', 'localtime') period,
           COUNT(*) orders, SUM(total) sales
    FROM orders WHERE status IN ('accepted','delivered') AND created_at BETWEEN ? AND ?
    GROUP BY period ORDER BY period DESC`).all(from, to));
});

// ---- Sales as CSV: ?type=orders|customers&range=7|30|365 ----
//  orders    -> one row per sold order, with the customer's sign-in details and how many items
//               that customer ordered in the period
//  customers -> one row per registered customer (also those with no orders), with items ordered
// "Sold" = accepted + delivered orders, same as the Sales tab.
const p2 = n => String(n).padStart(2, "0");
const dateOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const timeOf = ts => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const stamp = ts => (ts ? `${dateOf(ts)} ${timeOf(ts)}` : "");
// Names are typed by customers, so a leading = + - @ is neutralised (stops spreadsheet formula injection)
const csvCell = v => {
  let s = String(v ?? "");
  // (digits, spaces, + and - alone, like +91 98765 43210, cannot form a formula, so they stay as they are)
  if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?[0-9][0-9 +\-]*$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};

app.get("/api/admin/sales.csv", needAdmin, (req, res) => {
  const range = [7, 30, 365].includes(Number(req.query.range)) ? Number(req.query.range) : 7;
  const label = { 7: "last-1-week", 30: "last-1-month", 365: "last-1-year" }[range];
  const since = Date.now() - range * 86400000;
  const SOLD = "o.status IN ('accepted','delivered') AND o.created_at>=?";
  let header, rows, file;

  if (req.query.type === "customers") {
    file = "customers";
    header = ["Customer ID", "Name", "Email", "Phone", "Account created", "Last sign-in",
      "Orders (this period)", "Items ordered (this period)", "Total spent (INR)"];
    rows = counter.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND ${SOLD}) orders,
        (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id
           WHERE o.user_id=u.id AND ${SOLD}) items,
        (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id=u.id AND ${SOLD}) spent
      FROM users u ORDER BY items DESC, u.name`).all(since, since, since)
      .map(u => [u.id, u.name, u.email, u.phone, stamp(u.created_at), stamp(u.last_login_at), u.orders, u.items, u.spent]);
  } else {
    file = "sales";
    header = ["Order ID", "Date", "Time", "Status", "Row", "Seat", "Payment", "Items", "Items in order", "Total (INR)",
      "Customer ID", "Customer name", "Customer email", "Customer phone", "Account created", "Last sign-in",
      "Customer items ordered (this period)"];
    const list = counter.prepare(`
      SELECT o.*, u.name cname, u.email cemail, u.phone cphone, u.created_at ucreated, u.last_login_at ulogin,
        (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=o.id) n_items,
        (SELECT GROUP_CONCAT(qty || ' x ' || name, '; ') FROM order_items WHERE order_id=o.id) item_text
      FROM orders o LEFT JOIN users u ON u.id=o.user_id
      WHERE ${SOLD} ORDER BY o.created_at`).all(since);
    const perCustomer = {};
    list.forEach(o => { if (o.user_id) perCustomer[o.user_id] = (perCustomer[o.user_id] || 0) + o.n_items; });
    rows = list.map(o => [
      o.id, dateOf(o.created_at), timeOf(o.created_at), o.status, o.row, o.seat, o.payment, o.item_text, o.n_items, o.total,
      o.user_id || "", o.cname || "Guest (no account)", o.cemail || "", o.cphone || "",
      stamp(o.ucreated), stamp(o.ulogin), o.user_id ? perCustomer[o.user_id] : o.n_items
    ]);
  }

  const csv = [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${file}-${label}-${dateOf(Date.now())}.csv"`,
    "Cache-Control": "no-store"
  });
  res.send("\uFEFF" + csv); // BOM so Excel reads ₹ and accents correctly
});

// ---- Ratings: only the customer who placed the order, only after delivery ----
app.post("/api/orders/:id/rate", needUser, (req, res) => {
  const o = counter.prepare("SELECT status FROM orders WHERE id=? AND user_id=?").get(req.params.id, req.account.id);
  if (!o || o.status !== "delivered") return bad(res, "You can rate an order after it is delivered.");
  const ins = seat.prepare("INSERT OR REPLACE INTO ratings(order_id,item_id,stars,created_at) VALUES(?,?,?,?)");
  for (const r of Array.isArray(req.body.ratings) ? req.body.ratings : []) {
    const ok = counter.prepare("SELECT 1 FROM order_items WHERE order_id=? AND item_id=?").get(req.params.id, r.itemId);
    if (ok && r.stars >= 1 && r.stars <= 5) ins.run(req.params.id, r.itemId, r.stars, Date.now());
  }
  res.json({ ok: true });
});

// ---- Hero image + text (developer edits via PUT with admin token, or directly in seat.db) ----
app.get("/api/hero", (req, res) => res.json(seat.prepare("SELECT * FROM hero WHERE id=1").get()));
app.put("/api/admin/hero", needAdmin, (req, res) => {
  const { image = "", title, subtitle } = req.body;
  seat.prepare("UPDATE hero SET image=?, title=?, subtitle=? WHERE id=1").run(image, title, subtitle);
  res.json({ ok: true });
});

// ---- AI panel: chatbot, smart combo (logged-in customers only, so strangers cannot use your API key) ----
app.post("/api/ai/chat", needUser, async (req, res) => {
  const text = String(req.body.text || "").slice(0, 500);
  const menu = counter.prepare("SELECT id,name,category,price FROM menu WHERE in_stock=1").all();
  let reply;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 300,
          system: "You help cinema customers order snacks. Suggest combos only from this menu (prices in rupees): " +
            JSON.stringify(menu) + ". Keep replies short. Answer in the customer's language.",
          messages: [{ role: "user", content: text }]
        })
      });
      reply = (await r.json()).content?.[0]?.text;
    } catch (e) { /* fall back below */ }
  }
  if (!reply) { // simple fallback combo without an API key
    const pick = c => menu.find(m => m.category === c);
    const combo = ["Popcorn", "Drinks"].map(pick).filter(Boolean);
    reply = combo.length
      ? `Try ${combo.map(m => m.name).join(" + ")} for ₹${combo.reduce((s, m) => s + m.price, 0)}.`
      : "Menu is empty right now.";
  }
  seat.prepare("INSERT INTO chat_log(role,text,created_at) VALUES('user',?,?),('ai',?,?)").run(text, Date.now(), reply, Date.now());
  res.json({ reply });
});

// Bad JSON etc. -> a clean JSON error instead of an HTML stack trace
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const client = err.type === "entity.parse.failed" || err.type === "entity.too.large";
  if (!client) console.error(err);
  res.status(client ? 400 : 500).json({ error: client ? "Bad request" : "Something went wrong on the server" });
});

// ---------- Start-up check: tells you about the most common set-up mistakes ----------
function checkSetup() {
  const warn = msg => console.warn("\n!!  " + msg);
  if (!fs.existsSync(PUBLIC)) {
    warn('There is no folder named "public" next to server.js. Create it and put ALL the .html, .css and browser .js files inside it\n    (index.html, login.html, admin-login.html, admin.html, style.css, auth.css, auth.js, store.js, script.js, admin.js).');
  } else {
    const need = ["index.html", "login.html", "admin-login.html", "admin.html", "style.css", "auth.css", "auth.js", "store.js", "script.js", "admin.js"];
    const have = fs.readdirSync(PUBLIC);
    const missing = need.filter(f => !have.includes(f));
    if (missing.length) {
      warn("These files are missing from the public folder: " + missing.join(", "));
      const odd = have.filter(f => /admin.?login/i.test(f) && f !== "admin-login.html");
      if (odd.length) console.warn('    You have "' + odd[0] + '". Rename it to exactly:  admin-login.html  (with a hyphen, no spaces)');
    }
    const dash = path.join(PUBLIC, "admin.html");
    if (fs.existsSync(dash) && !fs.readFileSync(dash, "utf8").includes('id="orders"')) {
      warn("public/admin.html is NOT the counter dashboard (it looks like the login page). Put the dashboard page in admin.html.");
    }
  }
  if (!process.env.ADMIN_SIGNUP_CODE) warn("ADMIN_SIGNUP_CODE is not set, so Sign up on the counter login page is switched off.\n    Open settings.env, set it, and restart.");
  if (/^ChangeThis/i.test(process.env.ADMIN_PASSWORD || "") || /^ChangeThis/i.test(process.env.ADMIN_SIGNUP_CODE || "")) {
    warn("settings.env still has the sample password / staff code. Change them to your own secret values.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\nSet2eat is running.\n");
  console.log(`  Customers :  http://localhost:${PORT}/login.html`);
  console.log(`  Counter   :  http://localhost:${PORT}/admin-login.html`);
  console.log("\n  Open these addresses in your browser. Do NOT double-click the .html files:");
  console.log("  log in and sign up only work when the page comes from this server.");
  checkSetup();
  console.log("\n  Press Ctrl + C to stop the server.\n");
});