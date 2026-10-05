const BACKEND_URL = "https://exelidocv4-5.onrender.com";

const status = document.getElementById("status");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const createAccountBtn = document.getElementById("create-account-btn");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const plansSection = document.getElementById("plans-section");
const billingStatus = document.getElementById("billing-status");
const historySection = document.getElementById("history-section");
const historyList = document.getElementById("history-list");
const loadMoreHistoryButton = document.getElementById("load-more-history-btn");
let historyOffset = 0;
let authMode = "signin";

async function sessionFetch(path, options = {}) {
  const { sessionToken } = await chrome.storage.local.get("sessionToken");
  if (!sessionToken) throw new Error("no_session");
  return fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
      ...(options.headers || {}),
    },
  });
}

function renderHistory(items, append = false) {
  if (!append) historyList.replaceChildren();
  if (!items.length) {
    if (!append) historyList.textContent = "No saved requests yet.";
    return;
  }

  items.forEach((item) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${item.prompt || item.action} · ${item.client} · ${new Date(item.created_at).toLocaleString()}`;
    const prompt = document.createElement("p");
    prompt.className = "history-prompt";
    prompt.textContent = item.prompt || "";
    const response = document.createElement("pre");
    response.textContent = JSON.stringify(item.response, null, 2);
    details.append(summary, prompt, response);
    historyList.append(details);
  });
}

async function loadHistory(append = false) {
  if (!append) {
    historyOffset = 0;
    historyList.textContent = "Loading history...";
  }
  try {
    const response = await sessionFetch(`/api/history?limit=30&offset=${historyOffset}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load history");
    renderHistory(data.history || [], append);
    historyOffset += (data.history || []).length;
    loadMoreHistoryButton.hidden = !data.has_more;
  } catch (error) {
    historyList.textContent = error.message === "no_session" ? "Sign in to view history." : error.message;
  }
}

function setSignedIn(email) {
  emailInput.value = email || "";
  document.getElementById("account-access").hidden = Boolean(email);
  document.getElementById("password-update-section").hidden = !email;
  signOutBtn.hidden = !email;
  plansSection.hidden = !email;
  historySection.hidden = !email;
  status.textContent = email
    ? `Signed in as ${email}. Your account is remembered in this browser.`
    : "Create an account to use Exelidoc. Free accounts include 50 AI requests per 30 days.";
}

function setAuthMode(mode) {
  authMode = mode;
  const signingIn = mode === "signin";
  document.getElementById("sign-in-mode").setAttribute("aria-selected", String(signingIn));
  document.getElementById("sign-up-mode").setAttribute("aria-selected", String(!signingIn));
  signInBtn.hidden = !signingIn;
  createAccountBtn.hidden = signingIn;
  passwordInput.autocomplete = signingIn ? "current-password" : "new-password";
  status.textContent = signingIn ? "Sign in to use your Exelidoc account." : "Create a free account with at least 8 password characters.";
}

setAuthMode("signin");

chrome.storage.local.get(["sessionToken", "accountEmail"], (result) => {
  setSignedIn(result.sessionToken ? result.accountEmail : "");
  if (result.sessionToken) loadHistory();
});

document.getElementById("refresh-history-btn").addEventListener("click", () => loadHistory());
loadMoreHistoryButton.addEventListener("click", () => loadHistory(true));

document.getElementById("clear-history-btn").addEventListener("click", async () => {
  if (!window.confirm("Delete all saved AI history from this account?")) return;
  try {
    const response = await sessionFetch("/api/history", { method: "DELETE" });
    if (!response.ok) throw new Error("Could not clear history");
    renderHistory([]);
    historyOffset = 0;
    loadMoreHistoryButton.hidden = true;
  } catch (error) {
    historyList.textContent = error.message;
  }
});

async function submitAuth() {
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  if (!emailInput.validity.valid || !email) {
    status.textContent = "Enter a valid email address.";
    return;
  }
  if (!passwordInput.validity.valid || password.length < 8 || password.length > 128) {
    status.textContent = "Password must be between 8 and 128 characters.";
    return;
  }

  const submitButton = authMode === "signin" ? signInBtn : createAccountBtn;
  submitButton.disabled = true;
  status.textContent = authMode === "signin" ? "Signing in..." : "Creating your account...";
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/${authMode === "signin" ? "login" : "signup-free"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();

    if (response.ok && authMode === "signup" && data.verification_required) {
      status.textContent = data.message;
      return;
    }
    if (!response.ok || !data.session_token) {
      if (response.status === 409) {
        status.textContent = "An account already exists. Switch to Sign in.";
        return;
      }
      status.textContent = data.error || "Could not create your account. Try again shortly.";
      return;
    }

    chrome.storage.local.set({ sessionToken: data.session_token, accountEmail: data.email }, () => {
      passwordInput.value = "";
      setSignedIn(data.email);
      historyOffset = 0;
      loadHistory();
    });
  } catch (error) {
    console.error("Exelidoc: account access failed --", error);
    status.textContent = "Could not reach Exelidoc. Try again shortly.";
  } finally {
    submitButton.disabled = false;
  }
}

createAccountBtn.addEventListener("click", submitAuth);
signInBtn.addEventListener("click", submitAuth);
document.getElementById("sign-in-mode").addEventListener("click", () => setAuthMode("signin"));
document.getElementById("sign-up-mode").addEventListener("click", () => setAuthMode("signup"));

signOutBtn.addEventListener("click", () => {
  chrome.storage.local.remove(["sessionToken", "accountEmail"], () => {
    setSignedIn("");
    status.textContent = "Signed out.";
  });
});

document.getElementById("save-password-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const newPassword = document.getElementById("new-password-input");
  const updateStatus = document.getElementById("password-update-status");
  if (!newPassword.validity.valid || newPassword.value.length < 8 || newPassword.value.length > 128) {
    updateStatus.textContent = "Password must be between 8 and 128 characters.";
    return;
  }
  button.disabled = true;
  updateStatus.textContent = "Saving password...";
  try {
    const response = await sessionFetch("/api/auth/set-password", {
      method: "POST",
      body: JSON.stringify({ password: newPassword.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save password");
    newPassword.value = "";
    updateStatus.textContent = "Password saved. Use it to sign into your account on other devices.";
  } catch (error) {
    updateStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll(".checkout-btn").forEach((button) => {
  button.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const tier = button.dataset.tier;
    billingStatus.textContent = "Opening secure checkout...";
    document.querySelectorAll(".checkout-btn").forEach((item) => { item.disabled = true; });

    try {
      const response = await fetch(`${BACKEND_URL}/api/stripe/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_email: email, tier }),
      });
      const data = await response.json();

      if (!response.ok || !data.url) {
        billingStatus.textContent = data.error || "Could not start checkout. Try again shortly.";
        return;
      }

      chrome.tabs.create({ url: data.url });
      billingStatus.textContent = "Checkout opened in a new tab.";
    } catch (error) {
      console.error("Exelidoc: checkout request failed --", error);
      billingStatus.textContent = "Could not reach Exelidoc. Try again shortly.";
    } finally {
      document.querySelectorAll(".checkout-btn").forEach((item) => { item.disabled = false; });
    }
  });
});
