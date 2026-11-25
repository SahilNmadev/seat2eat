// Customer home page: hero slider (up to 3 slides, 1920 x 800). Slides come from the server.
(() => {
  // ================= EDIT HERE =================
  const HERO_LINKS = [
    "image1.png",   // a file next to index.html, or a full https:// link
    "image2.png",
    "image3.png"
  ];
  const HERO_SECONDS = 3;                        // slide changes every 3 seconds
  const HERO_TAGLINE = "Delivered to your seat"; // text on the banner ("" = hide)
  // =============================================

  const hero = document.getElementById("hero");
  const track = document.getElementById("hero-track");
  const dots = document.getElementById("hero-dots");
  if (!hero || typeof Store === "undefined") return;

  let slides = [], index = 0, timer = null;

  function go(i) {
    index = (i + slides.length) % slides.length;
    track.style.transform = `translateX(-${index * 100}%)`;
    [...dots.children].forEach((d, n) => d.classList.toggle("active", n === index));
  }
  function play() {
    clearInterval(timer);
    if (slides.length > 1) timer = setInterval(() => go(index + 1), HERO_SECONDS * 1000);
  }

  async function init() {
    // Images listed above win; if none of them load, use the banners saved in the counter dashboard
    const looksOk = u => /^https?:\/\//i.test(u) || /\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(u);
    const loads = u => new Promise(ok => { const i = new Image(); i.onload = () => ok(true); i.onerror = () => ok(false); i.src = u; });
    const wanted = HERO_LINKS.filter(looksOk).slice(0, 3);
    const found = await Promise.all(wanted.map(loads));
    slides = wanted.filter((_, n) => found[n]);   // files that do not exist are skipped
    if (!slides.length) {
      try { slides = ((await Store.hero()).slides || []).slice(0, 3); } catch (err) { slides = []; }
    }
    if (!slides.length) { hero.hidden = true; return; }

    track.innerHTML = slides.map(src => `<div class="hero-slide"><img src="${src.replace(/"/g, "&quot;")}" alt="Offer banner"></div>`).join("");
    dots.innerHTML = slides.map((_, i) => `<button type="button" class="hero-dot" aria-label="Slide ${i + 1}"></button>`).join("");
    const many = slides.length > 1;
    document.getElementById("hero-prev").hidden = !many;
    document.getElementById("hero-next").hidden = !many;
    dots.hidden = !many;
    if (HERO_TAGLINE) {
      hero.classList.add("has-tagline");
      const tag = document.createElement("p");
      tag.className = "hero-tagline";
      tag.textContent = HERO_TAGLINE;
      hero.appendChild(tag);
    }
    hero.hidden = false;
    go(0);
    play();
  }

  document.getElementById("hero-prev").addEventListener("click", () => { go(index - 1); play(); });
  document.getElementById("hero-next").addEventListener("click", () => { go(index + 1); play(); });
  dots.addEventListener("click", e => {
    const i = [...dots.children].indexOf(e.target.closest(".hero-dot"));
    if (i >= 0) { go(i); play(); }
  });
  hero.addEventListener("mouseenter", () => clearInterval(timer));
  hero.addEventListener("mouseleave", play);

  init();
})();