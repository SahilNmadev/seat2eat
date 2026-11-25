// ===== Add to server.js (REPLACES the old "Server hero snippet") =====
// Hero photos are now uploaded as a normal file (not inside JSON), so there is no size problem.

// 1) Near the top (once):
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));   // put this BEFORE your other routes

const HERO_FILE = path.join(__dirname, "hero.json");
const readHero = () => { try { return JSON.parse(fs.readFileSync(HERO_FILE, "utf8")); } catch (e) { return []; } };

// 2) Routes (after requireAdmin exists; use the name of YOUR admin middleware):
app.post("/api/admin/upload",
  requireAdmin,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "8mb" }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "No image received." });
    let ext = null;                                   // check the real file type, not just the header
    if (buf[0] === 0xff && buf[1] === 0xd8) ext = "jpg";
    else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = "png";
    else if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") ext = "webp";
    if (!ext) return res.status(400).json({ error: "Only JPG, PNG or WebP images are allowed." });
    const name = crypto.randomBytes(8).toString("hex") + "." + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ url: "/uploads/" + name });
  });

app.get("/api/hero", (req, res) => res.json({ slides: readHero() }));

app.put("/api/admin/hero", requireAdmin, (req, res) => {
  const list = Array.isArray(req.body.slides) ? req.body.slides.slice(0, 3) : [];
  const ok = s => /^https?:\/\//i.test(s) || /^\/uploads\/[\w.-]+$/.test(s);
  const slides = list.map(s => String(s || "").trim()).filter(ok);
  fs.writeFileSync(HERO_FILE, JSON.stringify(slides));
  res.json({ slides });
});