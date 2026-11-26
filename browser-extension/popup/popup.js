const BACKEND_URL = "https://exelidocv4-5.onrender.com";

const status = document.getElementById("status");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const createAccountBtn = document.getElementById("create-account-btn");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const plansSection = document.getElementById("plans-section");
const sourcesSection = document.getElementById("sources-section");
const billingStatus = document.getElementById("billing-status");
const accountPlanStatus = document.getElementById("account-plan-status");
const manageBillingButton = document.getElementById("manage-billing-btn");
const historySection = document.getElementById("history-section");
const historyList = document.getElementById("history-list");
const loadMoreHistoryButton = document.getElementById("load-more-history-btn");
const deleteAccountSection = document.getElementById("delete-account-section");
let historyOffset = 0;
let authMode = "signin";
let googleSearchResults = [];

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

function renderGmailScanStatus(connected, scan) {
  const scanButton = document.getElementById("scan-gmail-now-btn");
  scanButton.hidden = !connected;
  if (!connected) {
    document.getElementById("gmail-scan-status").textContent = "";
    return;
  }
  if (!scan) {
    document.getElementById("gmail-scan-status").textContent = "The local inbox index is starting.";
    return;
  }

  const count = Number(scan.indexedCount) || 0;
  const timestamp = scan.lastScanAt
    ? new Date(scan.lastScanAt).toLocaleString()
    : "";
  const statusText = {
    queued: "Inbox scan queued.",
    scanning: `Indexing your inbox locally: ${count} message(s) indexed so far.`,
    syncing_changes: `Updating the local index: ${count} message(s) indexed.`,
    ready: `${count} inbox message(s) indexed. Last scan: ${timestamp || "just now"}.`,
    error: `Inbox scan stopped: ${scan.lastError || "Unknown error."}`,
  }[scan.status] || "Inbox scan has not started yet.";
  document.getElementById("gmail-scan-status").textContent = statusText;
}

async function refreshGmailScanStatus() {
  try {
    const result = await sendRuntimeMessage({ type: "GET_GMAIL_SCAN_STATUS" });
    const connectButton = document.getElementById("connect-google-btn");
    connectButton.hidden = result.connected && result.accessConfigured;
    connectButton.textContent = result.connected
      ? "Finish Google setup (Gmail + Docs + Sheets)"
      : "Connect Google once (Gmail + Docs + Sheets)";
    document.getElementById("disconnect-google-btn").hidden = !result.connected;
    document.getElementById("google-status").textContent = result.connected
      ? result.accessConfigured
        ? "Google is ready. Inbox scanning refreshes every 5 minutes while Chrome is open."
        : "Finish Google setup once to enable Gmail context, Docs, and Sheets."
      : "Connect Google once to use Gmail messages in Docs, Sheets, and drafts.";
    renderGmailScanStatus(result.connected, result.scan);
  } catch (error) {
    document.getElementById("gmail-scan-status").textContent = error.message;
  }
}

function renderHistory(items, append = false) {
  if (!append) historyList.replaceChildren();
  const questions = items.filter((item) => typeof item.prompt === "string" && item.prompt.trim());
  if (!questions.length) {
    if (!append) historyList.textContent = "No saved questions yet.";
    return;
  }

  questions.forEach((item) => {
    const row = document.createElement("article");
    row.className = "history-item";
    const prompt = document.createElement("p");
    prompt.className = "history-prompt";
    prompt.textContent = item.prompt;
    row.append(prompt);

    if (Array.isArray(item.source_refs) && item.source_refs.length) {
      const form = document.createElement("form");
      const input = document.createElement("textarea");
      input.maxLength = 10000;
      input.required = true;
      input.placeholder = "Ask a follow-up about these sources";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Ask follow-up";
      const answer = document.createElement("p");
      form.append(input, submit, answer);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question) return;
        submit.disabled = true;
        answer.textContent = "Re-reading the selected sources...";
        try {
          const result = await sendRuntimeMessage({
            type: "FOLLOW_UP_HISTORY",
            prompt: question,
            previousPrompt: item.prompt,
            sourceRefs: item.source_refs,
          });
          if (!result.ok) throw new Error(result.error || "Could not answer the follow-up.");
          answer.textContent = result.answer || "Exelidoc returned no answer.";
        } catch (error) {
          answer.textContent = error.message;
        } finally {
          submit.disabled = false;
        }
      });
      row.append(form);
    }

    historyList.append(row);
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "No response from the extension."));
        return;
      }
      resolve(response);
    });
  });
}

function renderGoogleResults(items) {
  const resultsEl = document.getElementById("google-results");
  resultsEl.replaceChildren();
  googleSearchResults = items;
  if (!items.length) {
    resultsEl.textContent = "No matching emails, Docs, Sheets, or Slides were found.";
    updateAskSourcesButton();
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "google-result";
    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "google-result-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "google-source-checkbox";
    checkbox.value = String(index);
    checkbox.addEventListener("change", updateAskSourcesButton);
    const labelText = document.createElement("span");
    labelText.textContent = `Include ${item.type}: ${item.title}`;
    checkboxLabel.append(checkbox, labelText);
    row.append(checkboxLabel);

    try {
      const source = new URL(item.url);
      if (source.protocol === "https:") {
        const link = document.createElement("a");
        link.href = source.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open source";
        row.append(link);
      }
    } catch (error) {
      console.warn("Exelidoc: ignored invalid Google source URL", error);
    }

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Preview content";
    const content = document.createElement("pre");
    content.textContent = item.content;
    details.append(summary, content);
    row.append(details);
    resultsEl.append(row);
  });
  updateAskSourcesButton();
}

function updateAskSourcesButton() {
  const hasSelectedSources = document.querySelectorAll(".google-source-checkbox:checked").length > 0;
  const hasQuestion = Boolean(document.getElementById("source-question-input").value.trim());
  document.getElementById("ask-sources-btn").disabled = !(hasSelectedSources && hasQuestion);
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
  sourcesSection.hidden = !email;
  deleteAccountSection.hidden = !email;
  status.textContent = email
    ? `Signed in as ${email}. Your account is remembered in this browser.`
    : "Create an account to use Exelidoc. Free accounts include 5 AI requests every 24 hours.";
}

async function loadAccountStatus() {
  try {
    const response = await sessionFetch("/api/auth/account");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load account status.");

    accountPlanStatus.textContent = `Plan: ${data.tier}. Subscription: ${data.subscription_status.replaceAll("_", " ")}.`;
    manageBillingButton.hidden = !data.has_billing_account;
    document.querySelectorAll(".checkout-btn").forEach((button) => {
      button.hidden = ["active", "trialing", "past_due"].includes(data.subscription_status);
    });

    const deleteNote = document.getElementById("delete-account-note");
    const deleteButton = document.getElementById("delete-account-btn");
    if (!data.has_password) {
      deleteNote.textContent = "Set a password in the section above before deleting your account.";
      deleteButton.disabled = true;
    } else if (data.can_delete) {
      deleteNote.textContent = "Deleting your account permanently removes its Exelidoc history and signs this browser out. Stripe may retain billing records.";
      deleteButton.disabled = false;
    } else {
      deleteNote.textContent = "Cancel your paid subscription using Manage subscription. You can delete this account after Stripe confirms that the subscription has ended.";
      deleteButton.disabled = true;
    }
  } catch (error) {
    accountPlanStatus.textContent = error.message === "no_session"
      ? "Sign in again to view account status."
      : error.message;
    manageBillingButton.hidden = true;
    document.getElementById("delete-account-btn").disabled = true;
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const signingIn = mode === "signin";
  document.getElementById("sign-in-mode").setAttribute("aria-selected", String(signingIn));
  document.getElementById("sign-up-mode").setAttribute("aria-selected", String(!signingIn));
  signInBtn.hidden = !signingIn;
  createAccountBtn.hidden = signingIn;
  document.getElementById("forgot-password-btn").hidden = !signingIn;
  passwordInput.autocomplete = signingIn ? "current-password" : "new-password";
  status.textContent = signingIn ? "Sign in to use your Exelidoc account." : "Create a free account with at least 8 password characters.";
}

setAuthMode("signin");

chrome.storage.local.get(["sessionToken", "accountEmail"], (result) => {
  setSignedIn(result.sessionToken ? result.accountEmail : "");
  if (result.sessionToken) {
    loadHistory();
    loadAccountStatus();
  }
});

refreshGmailScanStatus();
chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (
    areaName === "local"
    && (changes.googleDataConnected || changes.gmailScanState)
  ) {
    refreshGmailScanStatus();
  }
});

document.getElementById("connect-google-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const googleStatus = document.getElementById("google-status");
  button.disabled = true;
  googleStatus.textContent = "Waiting for Google authorization...";
  try {
    await sendRuntimeMessage({ type: "CONNECT_GOOGLE_DATA" });
    await refreshGmailScanStatus();
    googleStatus.textContent = "Google is ready. Gmail refreshes every 5 minutes while Chrome is open.";
  } catch (error) {
    googleStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("disconnect-google-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const googleStatus = document.getElementById("google-status");
  button.disabled = true;
  try {
    await sendRuntimeMessage({ type: "DISCONNECT_GOOGLE_DATA" });
    await refreshGmailScanStatus();
    googleSearchResults = [];
    document.getElementById("google-results").replaceChildren();
    document.getElementById("source-answer").textContent = "";
    updateAskSourcesButton();
    googleStatus.textContent = "Google access was disconnected and the local inbox index was cleared. Remove Exelidoc from your Google account permissions to revoke the grant completely.";
  } catch (error) {
    googleStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("google-search-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const googleStatus = document.getElementById("google-status");
  const query = document.getElementById("google-search-input").value.trim();
  if (!query) {
    googleStatus.textContent = "Enter a search query first.";
    return;
  }
  button.disabled = true;
  googleStatus.textContent = "Searching connected Google sources...";
  document.getElementById("source-answer").textContent = "";
  try {
    const result = await sendRuntimeMessage({ type: "SEARCH_GOOGLE_SOURCES", query });
    renderGoogleResults(result.items || []);
    googleStatus.textContent = `${result.items.length} matching source(s). Select only the results you want Gemini to read.`;
  } catch (error) {
    googleStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("scan-gmail-now-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  document.getElementById("gmail-scan-status").textContent = "Scanning the inbox...";
  try {
    const result = await sendRuntimeMessage({ type: "SCAN_GMAIL_NOW" });
    renderGmailScanStatus(true, result.scan);
  } catch (error) {
    document.getElementById("gmail-scan-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("source-question-input").addEventListener("input", updateAskSourcesButton);

document.getElementById("ask-sources-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const googleStatus = document.getElementById("google-status");
  const selectedIndexes = Array.from(document.querySelectorAll(".google-source-checkbox:checked"))
    .map((checkbox) => Number(checkbox.value));
  const selectedSources = selectedIndexes.map((index) => googleSearchResults[index]).filter(Boolean);
  const question = document.getElementById("source-question-input").value.trim();
  if (!selectedSources.length || !question) return;

  const context = selectedSources.map((source, index) => (
    `Source ${index + 1}\nTitle: ${source.title}\nType: ${source.type}\nURL: ${source.url}\nContent:\n${source.content}`
  )).join("\n\n---\n\n").slice(0, 24_000);
  button.disabled = true;
  googleStatus.textContent = "Sending selected source content to Gemini...";
  try {
    const response = await sessionFetch("/api/ai/generate-text", {
      method: "POST",
      body: JSON.stringify({
        prompt: question,
        context,
        source_url: selectedSources[0].url,
        source_urls: selectedSources.map((source) => source.url),
        source_refs: selectedSources.map((source) => source.sourceRef).filter(Boolean),
        client: "chrome",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gemini could not answer this question.");
    document.getElementById("source-answer").textContent = data.generated || "Gemini returned no answer.";
    googleStatus.textContent = "Done. The question and safe source references are saved; source content and the answer are not.";
    loadHistory();
  } catch (error) {
    googleStatus.textContent = error.message;
  } finally {
    updateAskSourcesButton();
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
      loadAccountStatus();
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

document.getElementById("forgot-password-btn").addEventListener("click", async () => {
  const email = emailInput.value.trim().toLowerCase();
  if (!emailInput.validity.valid || !email) {
    status.textContent = "Enter the email address for your account first.";
    emailInput.focus();
    return;
  }

  const button = document.getElementById("forgot-password-btn");
  button.disabled = true;
  status.textContent = "Requesting a password reset...";
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not request a password reset.");
    status.textContent = data.message;
  } catch (error) {
    console.error("Exelidoc: password reset request failed --", error);
    status.textContent = "Could not reach Exelidoc. Try again shortly.";
  } finally {
    button.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => {
  chrome.storage.local.remove(["sessionToken", "accountEmail"], () => {
    passwordInput.value = "";
    document.getElementById("delete-password-input").value = "";
    document.getElementById("delete-confirmation-input").value = "";
    setSignedIn("");
    status.textContent = "Signed out.";
  });
});

manageBillingButton.addEventListener("click", async () => {
  manageBillingButton.disabled = true;
  billingStatus.textContent = "Opening secure billing management...";
  try {
    const response = await sessionFetch("/api/stripe/customer-portal", { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.url) {
      throw new Error(data.error || "Could not open billing management.");
    }
    chrome.tabs.create({ url: data.url });
    billingStatus.textContent = "Billing management opened in a new tab.";
  } catch (error) {
    billingStatus.textContent = error.message;
  } finally {
    manageBillingButton.disabled = false;
  }
});

document.getElementById("delete-account-btn").addEventListener("click", async () => {
  const password = document.getElementById("delete-password-input").value;
  const confirmation = document.getElementById("delete-confirmation-input").value.trim();
  const deleteStatus = document.getElementById("delete-account-status");
  const button = document.getElementById("delete-account-btn");
  if (!password || confirmation !== "DELETE") {
    deleteStatus.textContent = 'Enter your password and type "DELETE" exactly to confirm.';
    return;
  }

  if (!window.confirm("Permanently delete your Exelidoc account and its saved history? This cannot be undone.")) {
    return;
  }

  button.disabled = true;
  deleteStatus.textContent = "Deleting your account...";
  try {
    const response = await sessionFetch("/api/auth/account", {
      method: "DELETE",
      body: JSON.stringify({ password, confirmation }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not delete the account.");
    chrome.storage.local.remove(["sessionToken", "accountEmail"], () => {
      passwordInput.value = "";
      document.getElementById("delete-password-input").value = "";
      document.getElementById("delete-confirmation-input").value = "";
      setSignedIn("");
      deleteStatus.textContent = "Your account was deleted.";
      status.textContent = "Your account was deleted and this browser was signed out.";
    });
  } catch (error) {
    deleteStatus.textContent = error.message;
    button.disabled = false;
  }
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
    loadAccountStatus();
  } catch (error) {
    updateStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll(".checkout-btn").forEach((button) => {
  button.addEventListener("click", async () => {
    const tier = button.dataset.tier;
    billingStatus.textContent = "Opening secure checkout...";
    document.querySelectorAll(".checkout-btn").forEach((item) => { item.disabled = true; });

    try {
      const response = await sessionFetch("/api/stripe/create-checkout-session", {
        method: "POST",
        body: JSON.stringify({ tier }),
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
