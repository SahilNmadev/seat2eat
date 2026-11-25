// Login / sign-up page logic, shared by login.html (customers) and admin-login.html (counter)
(() => {
  const $ = id => document.getElementById(id);

  // Already logged in? Go straight to the page.
  // (If the saved login has expired, that page sends you back here and clears it.)
  if (Store.session()) { Store.goHome(); return; }

  const error = $("auth-error");

  function show(mode) {
    const login = mode === "login";
    $("login-form").hidden = !login;
    $("signup-form").hidden = login;
    $("tab-login").classList.toggle("active", login);
    $("tab-signup").classList.toggle("active", !login);
    $("tab-login").setAttribute("aria-selected", String(login));
    $("tab-signup").setAttribute("aria-selected", String(!login));
    error.textContent = "";
  }
  $("tab-login").addEventListener("click", () => show("login"));
  $("tab-signup").addEventListener("click", () => show("signup"));
  show(location.hash === "#signup" ? "signup" : "login");

  document.querySelectorAll(".auth-form").forEach(form => {
    form.addEventListener("submit", async event => {
      event.preventDefault();
      error.textContent = "";

      const data = Object.fromEntries(new FormData(form));
      if ("confirm" in data) {
        if (data.confirm !== data.password) { error.textContent = "The two passwords do not match."; return; }
        delete data.confirm;
      }

      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await Store.authenticate(form.dataset.kind, data);
        Store.goHome();
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
      }
    });
  });
})();