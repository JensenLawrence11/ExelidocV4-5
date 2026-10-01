const BACKEND_URL = "https://exelidocv4-5.onrender.com";

const status = document.getElementById("status");
const emailInput = document.getElementById("email-input");
const createAccountBtn = document.getElementById("create-account-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const plansSection = document.getElementById("plans-section");
const billingStatus = document.getElementById("billing-status");
const sharingSection = document.getElementById("sharing-section");
const historySection = document.getElementById("history-section");
const historyList = document.getElementById("history-list");
const linkCodeStatus = document.getElementById("link-code");
const loadMoreHistoryButton = document.getElementById("load-more-history-btn");
let historyOffset = 0;

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
  emailInput.disabled = Boolean(email);
  createAccountBtn.hidden = Boolean(email);
  signOutBtn.hidden = !email;
  plansSection.hidden = !email;
  sharingSection.hidden = !email;
  historySection.hidden = !email;
  status.textContent = email
    ? `Signed in as ${email}. Your account is remembered in this browser.`
    : "Create an account to use Exelidoc. Free accounts include 50 AI requests per 30 days.";
}

chrome.storage.local.get(["sessionToken", "accountEmail"], (result) => {
  setSignedIn(result.sessionToken ? result.accountEmail : "");
  if (result.sessionToken) loadHistory();
});

document.getElementById("create-link-code-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  linkCodeStatus.textContent = "Creating code...";
  try {
    const response = await sessionFetch("/api/auth/link-code", { method: "POST", body: "{}" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create a code");
    linkCodeStatus.textContent = `Enter this code in Office: ${data.code}`;
  } catch (error) {
    linkCodeStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
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

createAccountBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim().toLowerCase();
  if (!emailInput.validity.valid || !email) {
    status.textContent = "Enter a valid email address to create your account.";
    return;
  }

  createAccountBtn.disabled = true;
  status.textContent = "Creating your account...";
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/signup-free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json();

    if (response.status === 409) {
      status.textContent = "An account already exists for this email. Existing-account sign-in is not available in this beta yet.";
      return;
    }
    if (!response.ok || !data.session_token) {
      status.textContent = data.error || "Could not create your account. Try again shortly.";
      return;
    }

    chrome.storage.local.set({ sessionToken: data.session_token, accountEmail: data.email }, () => {
      setSignedIn(data.email);
      historyOffset = 0;
      loadHistory();
    });
  } catch (error) {
    console.error("Exelidoc: account signup failed --", error);
    status.textContent = "Could not reach Exelidoc. Try again shortly.";
  } finally {
    createAccountBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => {
  chrome.storage.local.remove(["sessionToken", "accountEmail"], () => {
    setSignedIn("");
    status.textContent = "Signed out.";
  });
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
