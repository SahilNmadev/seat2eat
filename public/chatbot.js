/* Set2eat AI Assistant: chat + voice + smart combos + suggestions.
   Works fully in the browser (no API key). Uses the live menu and the customer's own past orders.
   Load AFTER script.js (it uses the cart from there). The engine at the top is plain JS and can be tested in Node. */

const Set2eatBot = (() => {
  const inr = n => "₹" + Math.round(n).toLocaleString("en-IN");
  const DRINK_RE = /drink|juice|cola|soda|shake|water|tea|coffee|lassi|beverage|pepsi|coke|sprite|mojito|mocktail|smoothie/i;
  const COLD = ["cold", "drink", "juice", "cola", "soda", "shake", "ice"];
  const SYN = {
    thanda: COLD, thandi: COLD, thande: COLD, cold: COLD, pani: ["water", "drink"], peena: ["drink", "juice", "cola"],
    drink: ["drink", "juice", "cola", "soda", "shake", "water"], drinks: ["drink", "juice", "cola", "soda", "shake", "water"],
    meetha: ["sweet", "ice", "cream", "chocolate", "dessert", "brownie"], sweet: ["sweet", "ice", "cream", "chocolate", "dessert"],
    dessert: ["sweet", "ice", "cream", "chocolate", "dessert"],
    namkeen: ["chips", "nachos", "salted", "fries", "samosa"], snack: ["snack", "chips", "nachos", "fries", "samosa", "popcorn"],
    snacks: ["snack", "chips", "nachos", "fries", "samosa", "popcorn"], chatpata: ["spicy", "masala", "chaat"], spicy: ["spicy", "masala", "peri"],
    garam: ["hot", "tea", "coffee", "samosa"], bhookh: ["burger", "pizza", "sandwich", "fries", "nachos", "samosa"],
    hungry: ["burger", "pizza", "sandwich", "fries", "nachos", "samosa"], bhook: ["burger", "pizza", "sandwich", "fries", "nachos", "samosa"]
  };
  const STOP = new Set("kya hai hain mein main mujhe chahiye chahie karo kar do de dena dijiye aur ke ka ki ko se me hum mere meri the and for the with pls please show dikhao batao bata suggest combo pack paket deal meal sasta cheap popular best under below within budget tak andar ander rupees rupaye rupee log people persons person dost friends bande add order cart total last pichla repeat".split(" "));
  const NUM = { ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, four: 4 };

  const isDrink = i => DRINK_RE.test(i.name + " " + i.category);
  const has = (t, words) => words.some(w => new RegExp("\\b" + w + "\\b").test(t));

  function parse(raw) {
    const t = String(raw || "").toLowerCase().replace(/[₹,]/g, " ").replace(/\s+/g, " ").trim();
    const p = { text: t, budget: 0, people: 0, want: [], ordinal: 0 };
    const pm = t.match(/(\d+|ek|do|teen|char|one|two|three|four)\s*(log|people|persons|person|dost|friends|bande)/);
    if (pm) p.people = NUM[pm[1]] || Number(pm[1]) || 0;
    const bm = t.replace(pm ? pm[0] : "", " ").match(/(\d{2,4})/);
    if (bm) p.budget = Number(bm[1]);
    const toks = t.split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
    const want = new Set();
    toks.forEach(w => { want.add(w); (SYN[w] || []).forEach(x => want.add(x)); });
    p.want = [...want];
    const ord = t.match(/\b(pehla|pehle|first|1|ek|doosra|dusra|second|2|do|teesra|third|3|teen)\b/);
    if (ord) p.ordinal = { pehla: 1, pehle: 1, first: 1, 1: 1, ek: 1, doosra: 2, dusra: 2, second: 2, 2: 2, do: 2, teesra: 3, third: 3, 3: 3, teen: 3 }[ord[1]];
    return p;
  }

  const textScore = (i, o) => {
    const text = (i.name + " " + i.category + " " + (i.desc || "")).toLowerCase();
    return (o.want || []).reduce((s, w) => s + (text.includes(w) ? 3 : 0), 0);
  };
  const scoreItem = (i, o) => textScore(i, o) + ((o.history || {})[i.name.toLowerCase()] || 0) * 1.5;

  function buildCombos(menu, o) {
    const avail = menu.filter(i => i.inStock !== false);
    const people = Math.min(Math.max(o.people || 1, 1), 6);
    const sc = i => scoreItem(i, o);
    const foods = avail.filter(i => !isDrink(i)).sort((a, b) => sc(b) - sc(a)).slice(0, 10);
    const drinks = avail.filter(isDrink).sort((a, b) => sc(b) - sc(a)).slice(0, 8);
    const cands = [];
    const push = its => cands.push({ items: its, total: its.reduce((s, i) => s + i.price, 0) * people, score: its.reduce((s, i) => s + sc(i), 0) });
    if (foods.length && drinks.length) {
      foods.forEach(f => drinks.forEach(d => push([f, d])));
      foods.forEach((f, n) => foods.slice(n + 1).forEach(g => { if (g.category !== f.category) drinks.forEach(d => push([f, g, d])); }));
    } else {
      const pool = avail.slice(0, 12);
      pool.forEach((a, n) => pool.slice(n + 1).forEach(b => { if (a.category !== b.category) push([a, b]); }));
    }
    const cheapest = [...cands].sort((a, b) => a.total - b.total)[0] || null;
    const list = cands.filter(c => !o.budget || c.total <= o.budget)
      .sort((a, b) => b.score - a.score || (o.budget ? b.total - a.total : a.total - b.total));
    const out = [], used = new Set();
    for (const c of list) { if (out.length >= 3) break; if (c.items.some(i => used.has(i.id))) continue; out.push(c); c.items.forEach(i => used.add(i.id)); }
    for (const c of list) { if (out.length >= 3) break; if (!out.includes(c)) out.push(c); }
    return {
      combos: out.map(c => ({ items: c.items.map(item => ({ item, qty: people })), total: c.total })),
      cheapest: cheapest && { items: cheapest.items.map(item => ({ item, qty: people })), total: cheapest.total }
    };
  }

  function chips(menu, hasHistory) {
    const prices = menu.map(i => i.price).sort((a, b) => a - b);
    const mid = prices.length ? prices[Math.floor(prices.length / 2)] : 100;
    const b = Math.max(100, Math.round(mid * 3 / 50) * 50);
    const c = ["Combo suggest karo", `₹${b} mein combo`, "Kuch thanda?", "Sabse sasta kya hai?"];
    if (hasHistory) c.unshift("Mere last order jaisa");
    return c.slice(0, 4);
  }

  // state: { menu, history: {name: qty}, lastOrder: order|null, lastCombos: [], cartText: string }
  function reply(raw, state) {
    const menu = state.menu || [];
    const p = parse(raw);
    const t = p.text;
    const o = { ...p, history: state.history };
    const r = { text: "", combos: [], items: [], action: null, chips: chips(menu, !!state.lastOrder) };

    if (!menu.length) { r.text = "Menu abhi load nahi hua. Thodi der baad try karo."; return r; }

    if (/\b(add|lelo|le lo|daal|daalo)\b/.test(t) && state.lastCombos && state.lastCombos.length && !/suggest|recommend/.test(t)) {
      const n = Math.min(p.ordinal || 1, state.lastCombos.length);
      r.action = { type: "addCombo", index: n - 1 };
      r.text = `Theek hai, Combo ${n} cart mein daal raha hoon.`;
      return r;
    }
    if (has(t, ["thanks", "thank", "shukriya", "dhanyavad", "bye", "ok", "okay", "theek"]) && t.length < 25 && !p.budget && !/combo/.test(t)) { r.text = "Welcome! Aur kuch chahiye to bolo. Movie enjoy karo 🍿"; return r; }
    if (has(t, ["hi", "hii", "hello", "hey", "namaste", "hola"]) && t.length < 25 && !p.budget && !/combo/.test(t)) { r.text = "Namaste! Main aapka Set2eat assistant hoon. Budget, kitne log, ya kya khana hai bolo, main combo bana dunga."; return r; }
    if (has(t, ["repeat", "pichla", "last", "same", "wahi"])) {
      if (!state.lastOrder) { r.text = "Abhi tak aapka koi order nahi hai. Chalo ek combo try karte hain?"; return r; }
      const items = state.lastOrder.items.map(i => ({ item: menu.find(m => m.name === i.name && m.inStock !== false), qty: i.qty })).filter(x => x.item);
      if (!items.length) { r.text = "Pichle order ke items abhi available nahi hain."; return r; }
      r.text = "Ye raha aapka pichla order:";
      r.combos = [{ title: "Last order", items, total: items.reduce((s, x) => s + x.item.price * x.qty, 0) }];
      return r;
    }
    if (has(t, ["cart"]) || /\btotal\b/.test(t)) { r.text = state.cartText || "Cart khaali hai."; return r; }

    const comboAsk = has(t, ["combo", "pack", "paket", "deal", "meal", "suggest", "recommend", "popular", "best", "famous"]) || p.budget || p.people;
    if (comboAsk) {
      const { combos, cheapest } = buildCombos(menu, o);
      if (!combos.length) {
        r.text = p.budget && cheapest
          ? `${inr(p.budget)} mein combo nahi ban paa raha. Sabse sasta combo ${inr(cheapest.total)} ka hai.`
          : "Abhi combo banane layak items available nahi hain.";
        if (cheapest) r.combos = [{ title: "Sabse sasta", ...cheapest }];
        return r;
      }
      const who = p.people > 1 ? `${p.people} logon ke liye ` : "";
      r.text = p.budget ? `${inr(p.budget)} ke andar ${who}ye combos best hain:` : `${who}Ye combos try karo:`;
      if (Object.keys(state.history || {}).length && !p.want.length) r.text += " (aapke pehle ke orders ko dhyan mein rakha)";
      r.combos = combos;
      return r;
    }
    if (has(t, ["sasta", "cheap", "cheapest", "kam", "lowest"])) {
      const cheap = menu.filter(i => i.inStock !== false).sort((a, b) => a.price - b.price).slice(0, 4);
      r.text = "Sabse sasta options:"; r.items = cheap; return r;
    }
    if (p.want.length) {
      const found = menu.filter(i => i.inStock !== false && textScore(i, o) > 0).sort((a, b) => scoreItem(b, o) - scoreItem(a, o)).slice(0, 4);
      if (found.length) { r.text = "Ye mil gaya:"; r.items = found; return r; }
    }
    r.text = "Samajh nahi aaya 😅 Aap budget (jaise ₹200), kitne log, ya item ka naam bolo. Ya neeche se koi option chuno.";
    return r;
  }

  return { parse, buildCombos, reply, inr };
})();
if (typeof module !== "undefined") module.exports = Set2eatBot;

/* ===================== Chat window (browser only) ===================== */
(() => {
  if (typeof document === "undefined" || typeof Store === "undefined" || !document.getElementById("menu")) return;

  const E = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canSpeak = "speechSynthesis" in window;

  document.body.insertAdjacentHTML("beforeend", `
    <button type="button" id="bot-fab" class="bot-fab" aria-label="Open AI Assistant" aria-expanded="false">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
    </button>
    <section id="bot" class="bot" role="dialog" aria-label="AI Assistant" hidden>
      <header class="bot-head">
        <span class="bot-avatar" aria-hidden="true">S</span>
        <div class="bot-title"><strong>AI Assistant</strong><small>Set2eat</small></div>
        ${canSpeak ? '<button type="button" id="bot-speak" class="bot-icon" aria-pressed="false" title="Jawab bol kar sunao">🔈</button>' : ""}
        ${SR ? '<button type="button" id="bot-lang" class="bot-icon bot-lang" title="Voice language">हिं</button>' : ""}
        <button type="button" id="bot-close" class="bot-icon" aria-label="Close">✕</button>
      </header>
      <div id="bot-log" class="bot-log" aria-live="polite"></div>
      <div id="bot-chips" class="bot-chips"></div>
      <form id="bot-form" class="bot-form" autocomplete="off">
        ${SR ? '<button type="button" id="bot-mic" class="bot-mic" aria-label="Bol kar poochho">🎤</button>' : ""}
        <input id="bot-input" placeholder="Ketik pesan... ya mic dabao" maxlength="160">
        <button type="submit" class="bot-send" aria-label="Send">➤</button>
      </form>
    </section>`);

  const $b = id => document.getElementById(id);
  const log = $b("bot-log"), input = $b("bot-input");
  let packs = [], lastCombos = [], greeted = false, speakOn = false, lang = "hi-IN", rec = null, listening = false;

  const speak = text => {
    if (!speakOn || !canSpeak) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[^\p{L}\p{N}₹.,?! ]/gu, ""));
    u.lang = lang; speechSynthesis.speak(u);
  };

  const thumb = i => i.image ? `<img src="${E(i.image)}" alt="">` : `<span>${E(i.name.charAt(0))}</span>`;
  const packHtml = (pack, n) => {
    packs.push(pack);
    return `<div class="bot-pack">
      <div class="bot-pack-top"><b>${E(pack.title || "Combo " + (n + 1))}</b></div>
      ${pack.items.map(x => `<div class="bot-row"><span class="bot-thumb">${thumb(x.item)}</span>
        <span class="bot-name">${E(x.item.name)}<small>${x.qty} × ${Set2eatBot.inr(x.item.price)}</small></span></div>`).join("")}
      <div class="bot-pack-foot"><span><small>Total</small><br><b>${Set2eatBot.inr(pack.total)}</b></span>
        <button type="button" class="bot-add" data-pack="${packs.length - 1}">+ Add to cart</button></div></div>`;
  };
  const itemHtml = item => `<div class="bot-pack bot-single"><div class="bot-row"><span class="bot-thumb">${thumb(item)}</span>
    <span class="bot-name">${E(item.name)}<small>${Set2eatBot.inr(item.price)}</small></span>
    <button type="button" class="bot-add" data-item="${item.id}">Add</button></div></div>`;

  function add(role, html, plain) {
    log.insertAdjacentHTML("beforeend", `<div class="bot-msg bot-${role}">${html}</div>`);
    log.scrollTop = log.scrollHeight;
    if (role === "bot" && plain) speak(plain);
  }
  const setChips = list => {
    $b("bot-chips").innerHTML = list.map(c => `<button type="button" class="bot-chip">${E(c)}</button>`).join("");
  };

  function addToCart(items) {
    items.forEach(({ item, qty }) => { cart[item.id] = Math.min((cart[item.id] || 0) + qty, 20); });
    refresh();
    const n = Object.values(cart).reduce((a, b) => a + b, 0);
    const msg = `Cart mein add ho gaya ✅ Ab cart mein ${n} item(s) hain, total ${money(cartTotal())}. Checkout karne ke liye "Cart" dabao.`;
    add("bot", E(msg), msg);
  }

  async function ask(text) {
    text = text.trim();
    if (!text) return;
    add("user", E(text));
    input.value = "";
    let history = {}, lastOrder = null;
    try {
      const orders = await Store.myOrders();
      lastOrder = orders[0] || null;
      orders.forEach(o => o.items.forEach(i => { const k = i.name.toLowerCase(); history[k] = (history[k] || 0) + i.qty; }));
    } catch (err) { /* assistant still works without history */ }
    const count = Object.values(cart).reduce((a, b) => a + b, 0);
    const state = { menu: MENU, history, lastOrder, lastCombos,
      cartText: count ? `Cart mein ${count} item(s) hain, total ${money(cartTotal())}.` : "Cart abhi khaali hai." };
    const r = Set2eatBot.reply(text, state);

    if (r.action && r.action.type === "addCombo") { addToCart(lastCombos[r.action.index].items); return; }
    packs = [];
    let html = `<p>${E(r.text)}</p>` + r.combos.map(packHtml).join("") + r.items.map(itemHtml).join("");
    add("bot", html, r.text);
    if (r.combos.length) lastCombos = r.combos.map(c => ({ items: c.items }));
    window.__botPacks = packs;
    setChips(r.chips);
  }

  // ----- events -----
  const open = () => {
    $b("bot").hidden = false; $b("bot-fab").setAttribute("aria-expanded", "true"); $b("bot-fab").hidden = true;
    if (!greeted) {
      greeted = true;
      const g = "Namaste! Kya khana hai? Budget, kitne log, ya item ka naam bolo. Main combo bana dunga.";
      add("bot", `<p>${E(g)}</p>`);
      setChips(Set2eatBot.reply("", { menu: MENU }).chips);
    }
    input.focus();
  };
  const close = () => { $b("bot").hidden = true; $b("bot-fab").hidden = false; $b("bot-fab").setAttribute("aria-expanded", "false"); if (canSpeak) speechSynthesis.cancel(); };
  $b("bot-fab").addEventListener("click", open);
  $b("bot-close").addEventListener("click", close);
  $b("bot-form").addEventListener("submit", e => { e.preventDefault(); ask(input.value); });
  $b("bot-chips").addEventListener("click", e => { const c = e.target.closest(".bot-chip"); if (c) ask(c.textContent); });
  log.addEventListener("click", e => {
    const b = e.target.closest(".bot-add");
    if (!b) return;
    if (b.dataset.pack !== undefined) {
      const pack = (window.__botPacks || [])[Number(b.dataset.pack)];
      if (pack) addToCart(pack.items);
    } else {
      const item = MENU.find(m => m.id === Number(b.dataset.item));
      if (item) addToCart([{ item, qty: 1 }]);
    }
  });

  if ($b("bot-speak")) $b("bot-speak").addEventListener("click", e => {
    speakOn = !speakOn; e.currentTarget.setAttribute("aria-pressed", String(speakOn));
    e.currentTarget.textContent = speakOn ? "🔊" : "🔈"; if (!speakOn) speechSynthesis.cancel();
  });
  if ($b("bot-lang")) $b("bot-lang").addEventListener("click", e => {
    lang = lang === "hi-IN" ? "en-IN" : "hi-IN"; e.currentTarget.textContent = lang === "hi-IN" ? "हिं" : "EN";
  });
  if ($b("bot-mic")) $b("bot-mic").addEventListener("click", () => {
    if (listening && rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = lang; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onstart = () => { listening = true; $b("bot-mic").classList.add("on"); input.placeholder = "Sun raha hoon..."; };
    rec.onend = () => { listening = false; $b("bot-mic").classList.remove("on"); input.placeholder = "Ketik pesan... ya mic dabao"; };
    rec.onresult = ev => ask(ev.results[0][0].transcript);
    rec.onerror = ev => {
      const m = ev.error === "not-allowed" ? "Mic ki permission band hai. Browser mein mic allow karo." :
        ev.error === "no-speech" ? "Kuch sunai nahi diya. Phir se try karo." : "Voice kaam nahi kar rahi. Type karke poochho.";
      add("bot", `<p>${E(m)}</p>`);
    };
    try { rec.start(); } catch (err) { /* already running */ }
  });
})();