// ===== Add to server.js =====
// 1) Near the top (once):
const fs = require("fs");
const path = require("path");
const HERO_FILE = path.join(__dirname, "hero.json");
const readHero = () => { try { return JSON.parse(fs.readFileSync(HERO_FILE, "utf8")); } catch (e) { return []; } };

// 2) Uploaded photos are sent as data URLs, so raise the JSON limit (replace your existing express.json line):
//    app.use(express.json({ limit: "10mb" }));

// 3) Routes (after your auth middleware is defined). Replace `requireAdmin` with the
//    name of the middleware you already use on the /api/admin/... routes.
app.get("/api/hero", (req, res) => {
  res.json({ slides: readHero() });
});

app.put("/api/admin/hero", requireAdmin, (req, res) => {
  const list = Array.isArray(req.body.slides) ? req.body.slides.slice(0, 3) : [];
  const ok = s => /^https?:\/\//i.test(s) || /^data:image\/(jpeg|png|webp);base64,/i.test(s);
  const slides = list.map(s => String(s || "").trim()).filter(ok);
  if (slides.some(s => s.length > 4_000_000)) return res.status(400).json({ error: "One of the images is too large." });
  fs.writeFileSync(HERO_FILE, JSON.stringify(slides));
  res.json({ slides });
});