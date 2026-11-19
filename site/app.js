(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (id) => document.getElementById(id);
  const COGNITO = `https://cognito-idp.${C.authRegion}.amazonaws.com/`;

  // Region order: A first, then B as automatic fallback. Open the site with
  // #region=b to force region B first (handy for demoing the second region).
  const apis = location.hash === "#region=b" ? [...C.apis].reverse() : [...C.apis];

  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("session")); } catch { session = null; }
  let pendingEmail = "";

  function say(text, isError) {
    const m = $("msg");
    m.textContent = text || "";
    m.className = isError ? "error" : "";
  }

  function show(which) {
    for (const id of ["signin", "signup", "confirm"]) $(id).hidden = id !== which;
    say("");
  }

  async function cognito(target, body) {
    const r = await fetch(COGNITO, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService." + target,
      },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Request failed");
    return j;
  }

  function saveSession(res, email, prior) {
    session = {
      email,
      idToken: res.IdToken,
      accessToken: res.AccessToken,
      refreshToken: res.RefreshToken || (prior && prior.refreshToken),
      expires: Date.now() + (res.ExpiresIn - 60) * 1000,
    };
    sessionStorage.setItem("session", JSON.stringify(session));
  }

  async function token() {
    if (!session) throw new Error("Please sign in.");
    if (Date.now() > session.expires) {
      try {
        const r = await cognito("InitiateAuth", {
          AuthFlow: "REFRESH_TOKEN_AUTH",
          ClientId: C.clientId,
          AuthParameters: { REFRESH_TOKEN: session.refreshToken },
        });
        saveSession(r.AuthenticationResult, session.email, session);
      } catch (e) {
        clearSession();
        throw new Error("Session expired. Please sign in again.");
      }
    }
    return session.idToken;
  }

  function clearSession() {
    session = null;
    sessionStorage.removeItem("session");
    render();
  }

  // Calls the API in region A, falling back to region B on network errors / 5xx.
  async function api(path, options = {}) {
    const idToken = await token();
    let last;
    for (const base of apis) {
      try {
        const r = await fetch(base + path, {
          ...options,
          headers: { ...(options.headers || {}), Authorization: idToken },
        });
        if (r.status >= 500) { last = new Error("Server error (" + r.status + ")"); continue; }
        if (r.status === 401) { clearSession(); throw new Error("Please sign in again."); }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "Request failed (" + r.status + ")");
        return body;
      } catch (e) {
        if (e instanceof TypeError) { last = e; continue; } // network failure -> try next region
        throw e;
      }
    }
    throw last || new Error("All regions unavailable");
  }

  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";

  async function refreshList() {
    const rows = await api("/files");
    const tbody = $("list");
    tbody.replaceChildren();
    $("empty").hidden = rows.length > 0;
    for (const f of rows) {
      const tr = document.createElement("tr");
      for (const text of [f.name, fmtSize(f.size), new Date(f.modified).toLocaleString()]) {
        const td = document.createElement("td");
        td.textContent = text;           // textContent: file names can never inject HTML
        tr.appendChild(td);
      }
      const actions = document.createElement("td");
      actions.className = "actions";
      const dl = document.createElement("button");
      dl.textContent = "Download";
      dl.addEventListener("click", () => download(f.name));
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "danger";
      del.addEventListener("click", () => remove(f.name));
      actions.append(dl, del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }

  async function download(name) {
    try {
      const { url } = await api("/download-url?name=" + encodeURIComponent(name));
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) { say(e.message, true); }
  }

  async function remove(name) {
    if (!confirm("Delete " + name + "?")) return;
    try {
      await api("/files?name=" + encodeURIComponent(name), { method: "DELETE" });
      say("Deleted " + name);
      await refreshList();
    } catch (e) { say(e.message, true); }
  }

  function render() {
    const signedIn = !!session;
    $("auth").hidden = signedIn;
    $("files").hidden = !signedIn;
    if (signedIn) {
      $("who").textContent = session.email;
      refreshList().catch((e) => say(e.message, true));
    } else {
      show("signin");
    }
  }

  $("to-signup").addEventListener("click", (e) => { e.preventDefault(); show("signup"); });
  $("to-signin-1").addEventListener("click", (e) => { e.preventDefault(); show("signin"); });
  $("to-signin-2").addEventListener("click", (e) => { e.preventDefault(); show("signin"); });

  $("signup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("su-email").value.trim();
    try {
      await cognito("SignUp", {
        ClientId: C.clientId, Username: email, Password: $("su-pass").value,
        UserAttributes: [{ Name: "email", Value: email }],
      });
      pendingEmail = email;
      show("confirm");
      say("We emailed you a confirmation code.");
    } catch (err) { say(err.message, true); }
  });

  $("confirm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await cognito("ConfirmSignUp", {
        ClientId: C.clientId, Username: pendingEmail, ConfirmationCode: $("cf-code").value.trim(),
      });
      show("signin");
      $("si-email").value = pendingEmail;
      say("Account confirmed. You can sign in now.");
    } catch (err) { say(err.message, true); }
  });

  $("signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("si-email").value.trim();
    try {
      const r = await cognito("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH", ClientId: C.clientId,
        AuthParameters: { USERNAME: email, PASSWORD: $("si-pass").value },
      });
      if (!r.AuthenticationResult) throw new Error("Additional sign-in step required (not supported).");
      saveSession(r.AuthenticationResult, email);
      $("si-pass").value = "";
      say("");
      render();
    } catch (err) { say(err.message, true); }
  });

  $("signout").addEventListener("click", async () => {
    try { await cognito("GlobalSignOut", { AccessToken: session.accessToken }); } catch { /* token may already be expired */ }
    clearSession();
    say("Signed out.");
  });

  $("upload").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("file").files[0];
    if (!file) return;
    if (file.size > C.maxBytes) { say("File is larger than " + fmtSize(C.maxBytes) + ".", true); return; }
    const btn = e.submitter;
    btn.disabled = true;
    say("Uploading " + file.name + "...");
    try {
      const post = await api("/upload-url?name=" + encodeURIComponent(file.name), { method: "POST" });
      const form = new FormData();
      for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
      form.append("file", file);                 // must be the last field
      const r = await fetch(post.url, { method: "POST", body: form });
      if (!r.ok) throw new Error("Upload failed (" + r.status + ")");
      $("file").value = "";
      say("Uploaded " + file.name);
      await refreshList();
    } catch (err) { say(err.message, true); }
    btn.disabled = false;
  });

  render();
})();
