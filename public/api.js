(() => {
  "use strict";

  // Remove credentials left by older versions of the panel.
  localStorage.removeItem("nfse_api_token");
  let csrfToken = "";
  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("nfse_auth")
      : null;
  const dialog = document.createElement("dialog");
  dialog.id = "modalLogin";
  dialog.setAttribute("aria-labelledby", "loginTitle");
  dialog.innerHTML = `
    <form class="modal login-form" id="loginForm">
      <h3 id="loginTitle">Entrar no painel</h3>
      <p>Use as credenciais do escritório para acessar notas, empresas e certificados.</p>
      <label for="loginUsername">Usuário</label>
      <input id="loginUsername" name="username" autocomplete="username" maxlength="200" required />
      <label for="loginPassword">Senha</label>
      <input id="loginPassword" name="password" type="password" autocomplete="current-password" maxlength="1024" required />
      <p id="loginError" class="form-error" role="alert" hidden></p>
      <div class="modal-actions">
        <button class="btn btn-primary" id="loginSubmit" type="submit">Entrar</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  const username = document.getElementById("loginUsername");
  const password = document.getElementById("loginPassword");
  const error = document.getElementById("loginError");
  const submit = document.getElementById("loginSubmit");
  const buttons = document.querySelectorAll("[data-auth]");
  const notifyChange = () => {
    channel?.postMessage("changed");
    window.dispatchEvent(new CustomEvent("nfse:authchange"));
  };

  function configure(message = "") {
    csrfToken = "";
    error.textContent = message;
    error.hidden = !message;
    if (!dialog.open) {
      password.value = "";
      dialog.showModal();
      username.focus();
    }
  }

  async function authRequest(path, options = {}) {
    return fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Nfse-Request": "panel",
        "X-CSRF-Token": csrfToken,
      },
    });
  }

  const ready = (async () => {
    try {
      const response = await authRequest("/auth/session");
      if (!response.ok) {
        configure();
        return;
      }
      csrfToken = (await response.json()).csrfToken;
    } catch {
      configure("Não foi possível verificar o acesso. Tente entrar novamente.");
    }
  })();

  async function request(path, options = {}) {
    if (!path.startsWith("/api/") || path.includes("\\"))
      throw new Error("O cliente da API aceita apenas rotas internas /api/.");
    await ready;
    if (!csrfToken) {
      configure();
      throw new Error("Não autorizado");
    }
    const headers = new Headers(options.headers);
    if (typeof options.body === "string" && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", csrfToken);
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers,
    });
    if (response.status === 401) {
      configure("Sua sessão expirou. Entre novamente para continuar.");
      throw new Error("Não autorizado");
    }
    return response;
  }

  document
    .getElementById("loginForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = "Entrando…";
      error.hidden = true;
      try {
        const response = await authRequest("/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: username.value,
            password: password.value,
          }),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Não foi possível entrar.");
        csrfToken = result.csrfToken;
        password.value = "";
        dialog.close();
        notifyChange();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = "Entrar";
      }
    });
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  buttons.forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await ready;
        if (!csrfToken) {
          configure();
          return;
        }
        const response = await authRequest("/auth/logout", { method: "POST" });
        if (!response.ok)
          throw new Error("Não foi possível sair. Recarregue a página.");
        csrfToken = "";
        channel?.postMessage("changed");
        window.location.reload();
      } catch (failure) {
        window.alert(failure.message);
      } finally {
        button.disabled = false;
      }
    }),
  );
  if (channel) channel.onmessage = () => window.location.reload();
  window.NfseApi = Object.freeze({ configure, request });
})();
