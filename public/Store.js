/*
  store.js - shared data layer for all four pages.

  Talks to the Express server (server.js). Each page sets <body data-role="customer">
  or <body data-role="admin">, and this file keeps a separate login session for each role,
  so a customer login can never open the counter dashboard (and the other way round).
*/
const Store = (() => {
  const role = document.body.dataset.role === "admin" ? "admin" : "customer";
  const SESSION_KEY = `set2eat.${role}.session`;
  const LOGIN_PAGE = role === "admin" ? "admin-login.html" : "login.html";
  const HOME_PAGE = role === "admin" ? "admin.html" : "index.html";
  const AUTH = role === "admin" ? "/api/admin/auth" : "/api/auth";

  // ----- Session (token + name, kept in this browser) -----
  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (err) { return null; }
  }
  const setSession = s => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  const clearSession = () => localStorage.removeItem(SESSION_KEY);

  // ----- One place that talks to the server -----
  // noRedirect: for login / sign-up calls, where a 401 means "wrong password", not "session ended"
  async function api(path, { method = "GET", body, raw = false, noRedirect = false } = {}) {
    const session = getSession();
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (session) headers.Authorization = "Bearer " + session.token;

    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (err) {
      if (location.protocol === "file:") {
        throw new Error("This page was opened as a file. Start the server (npm start) and open http://localhost:3000/login.html in your browser instead.");
      }
      throw new Error("Cannot reach the server. Is it running?");
    }

    if (res.status === 401 && session && !noRedirect) {
      clearSession();
      location.replace(LOGIN_PAGE);
      throw new Error("Your session ended. Please log in again.");
    }
    if (raw) {
      if (!res.ok) throw new Error("Download failed (" + res.status + ").");
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  return {
    role,
    session: getSession,

    // ----- Accounts -----
    // Call at the top of a protected page. Sends you to the login page when not logged in.
    requireLogin() {
      if (getSession()) return true;
      location.replace(LOGIN_PAGE);
      return false;
    },
    goHome() { location.replace(HOME_PAGE); },

    // kind: "login" | "signup"
    async authenticate(kind, data) {
      const out = await api(`${AUTH}/${kind}`, { method: "POST", body: data, noRedirect: true });
      setSession({ token: out.token, ...out.user });
      return out.user;
    },
    // Checks the saved login is still valid and refreshes the name
    async me() {
      const out = await api(`${AUTH}/me`);
      setSession({ ...getSession(), ...out.user });
      return out.user;
    },
    async logout() {
      try { await api(`${AUTH}/logout`, { method: "POST", noRedirect: true }); } catch (err) { /* leave anyway */ }
      clearSession();
      location.replace(LOGIN_PAGE);
    },

    // ----- Menu (anyone can read) -----
    menu() { return api("/api/menu", { noRedirect: true }); },
    addMenuItem(data) { return api("/api/admin/menu", { method: "POST", body: data }); },
    removeMenuItem(id) { return api(`/api/admin/menu/${id}`, { method: "DELETE" }); },
    // Change fields of one item, e.g. { inStock: false } or { image: "..." }
    updateMenuItem(id, changes) { return api(`/api/admin/menu/${id}`, { method: "PATCH", body: changes }); },

    // ----- Home page banners (hero slider) -----
    hero() { return api("/api/hero", { noRedirect: true }); },                       // { slides: [url, ...] }
    saveHero(slides) { return api("/api/admin/hero", { method: "PUT", body: { slides } }); },

    // ----- Customer orders -----
    // data: { row, seat, payment, items: [{ id, qty }] }. Prices are looked up on the server.
    placeOrder(data) { return api("/api/orders", { method: "POST", body: data }); },
    myOrders() { return api("/api/orders/mine"); }, // newest first

    // ----- Counter orders -----
    orders() { return api("/api/admin/orders"); },
    // status: "accepted" | "rejected" | "delivered"
    setStatus(id, status) { return api(`/api/admin/orders/${id}`, { method: "PATCH", body: { status } }); },

    // type: "orders" | "customers", range: 7 | 30 | 365 (days)
    async downloadCsv(type, range) {
      const res = await api(`/api/admin/sales.csv?type=${type}&range=${range}`, { raw: true });
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const name = (disposition.match(/filename="([^"]+)"/) || [])[1] || `${type}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    // Reads a photo file, shrinks it, and returns a small JPEG (as a data URL)
    readImage(file, maxSize = 640, quality = 0.78) {
      return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith("image/")) {
          reject(new Error("Please choose an image file."));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the photo."));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error("This photo could not be opened."));
          img.onload = () => {
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", quality));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    },

    // Resizes a photo and returns a JPEG Blob (used for big banner images)
    readImageBlob(file, maxSize = 1920, quality = 0.82) {
      return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith("image/")) { reject(new Error("Please choose an image file.")); return; }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This photo could not be opened.")); };
        img.onload = () => {
          URL.revokeObjectURL(url);
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(b => b ? resolve(b) : reject(new Error("Could not process the photo.")), "image/jpeg", quality);
        };
        img.src = url;
      });
    },

    // Sends the image as a file (not inside JSON) and returns its URL, e.g. "/uploads/ab12.jpg"
    async uploadImage(blob) {
      const session = getSession();
      let res;
      try {
        res = await fetch("/api/admin/upload", {
          method: "POST",
          headers: { "Content-Type": blob.type || "image/jpeg", Authorization: "Bearer " + (session ? session.token : "") },
          body: blob
        });
      } catch (err) { throw new Error("Cannot reach the server. Is it running?"); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed (" + res.status + "). Did you add the upload route to server.js?");
      return data.url;
    },

    // Runs fn now and then every `ms` milliseconds (replaces the old live "storage" updates).
    // Errors are ignored so a short server hiccup does not break the page.
    poll(fn, ms) {
      let busy = false;
      setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await fn(); } catch (err) { /* try again next time */ } finally { busy = false; }
      }, ms);
    }
  };
})();