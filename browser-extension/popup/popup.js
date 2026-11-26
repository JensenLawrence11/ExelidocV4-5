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
let currentGoogleSheet = null;
let googleSheetSnapshot = null;
let googleSheetProposal = null;

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
    const row = document.createElement("article");
    const metadata = document.createElement("p");
    metadata.textContent = `${item.action} · ${item.client} · ${new Date(item.created_at).toLocaleString()}`;
    row.append(metadata);
    const sourceUrls = Array.isArray(item.source_urls) && item.source_urls.length
      ? item.source_urls
      : [item.source_url];
    sourceUrls.forEach((sourceUrl, index) => {
      if (typeof sourceUrl !== "string") return;
      try {
        const source = new URL(sourceUrl);
        if (source.protocol === "https:") {
          const link = document.createElement("a");
          link.href = source.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = sourceUrls.length > 1 ? `Open source ${index + 1}` : "Open source";
          row.append(link);
        }
      } catch (error) {
        console.warn("Exelidoc history: invalid source link", error);
      }
    });
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
  document.getElementById("google-sheet-editor").hidden = true;
  currentGoogleSheet = null;
  googleSheetSnapshot = null;
  googleSheetProposal = null;
  googleSearchResults = items;
  if (!items.length) {
    resultsEl.textContent = "No matching emails, Docs, Sheets, or Slides were found.";
    updateAskSourcesButton();
    return;
  }

  if (item.type === "spreadsheet" && item.spreadsheetId && item.sheetTitles?.length) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "google-sheet-edit-btn";
    editButton.textContent = "Edit cells with AI preview";
    editButton.addEventListener("click", () => selectGoogleSheet(item));
    row.append(editButton);
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

function selectGoogleSheet(source) {
  currentGoogleSheet = source;
  googleSheetSnapshot = null;
  googleSheetProposal = null;
  const editor = document.getElementById("google-sheet-editor");
  const tabs = document.getElementById("google-sheet-tab");
  tabs.replaceChildren();
  source.sheetTitles.forEach((title) => {
    const option = document.createElement("option");
    option.value = title;
    option.textContent = title;
    tabs.append(option);
  });
  document.getElementById("google-sheet-editor-title").textContent = `Edit cells: ${source.title}`;
  document.getElementById("google-sheet-range").value = "A1:Z90";
  document.getElementById("google-sheet-edit-controls").hidden = true;
  document.getElementById("google-sheet-preview-section").hidden = true;
  document.getElementById("google-sheet-edit-status").textContent = "Load a range before asking Gemini to propose changes.";
  editor.hidden = false;
  editor.scrollIntoView({ block: "nearest" });
}

function getSheetCellAddress(snapshot, row, column) {
  const start = snapshot.range.split(":")[0].match(/^([A-Z]+)(\d+)$/);
  if (!start) return `row ${row + 1}, column ${column + 1}`;
  let columnNumber = start[1].split("").reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0
  ) + column;
  let letters = "";
  while (columnNumber > 0) {
    letters = String.fromCharCode(((columnNumber - 1) % 26) + 65) + letters;
    columnNumber = Math.floor((columnNumber - 1) / 26);
  }
  return `${letters}${Number(start[2]) + row}`;
}

function isSheetFormula(value) {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

function describeSheetValue(value) {
  if (value === null) return "(blank)";
  return JSON.stringify(value);
}

function renderGoogleSheetProposal(correctedValues) {
  if (
    !Array.isArray(correctedValues)
    || correctedValues.length !== googleSheetSnapshot.values.length
    || correctedValues.some((row, index) => (
      !Array.isArray(row) || row.length !== googleSheetSnapshot.values[index].length
    ))
  ) {
    throw new Error("Gemini returned a spreadsheet preview with an invalid shape.");
  }

  const changes = [];
  let formulaChanges = 0;
  googleSheetSnapshot.values.forEach((row, rowIndex) => {
    row.forEach((before, columnIndex) => {
      const after = correctedValues[rowIndex][columnIndex];
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const formulaChange = isSheetFormula(before) || isSheetFormula(after);
      if (formulaChange) formulaChanges += 1;
      changes.push({
        address: getSheetCellAddress(googleSheetSnapshot, rowIndex, columnIndex),
        before,
        after,
        formulaChange,
      });
    });
  });

  googleSheetProposal = { correctedValues, changes, formulaChanges };
  const preview = document.getElementById("google-sheet-preview");
  if (!changes.length) {
    preview.textContent = "Gemini proposed no cell changes.";
  } else {
    const lines = [
      `${changes.length} cell change(s)${formulaChanges ? `; ${formulaChanges} formula change(s)` : ""}:`,
      ...changes.slice(0, 100).map((change) => (
        `${change.address}${change.formulaChange ? " [FORMULA]" : ""}: ${describeSheetValue(change.before)} -> ${describeSheetValue(change.after)}`
      )),
    ];
    if (changes.length > 100) lines.push(`...and ${changes.length - 100} more change(s).`);
    preview.textContent = lines.join("\n");
  }

  const formulaLabel = document.getElementById("confirm-google-formula-label");
  const formulaCheckbox = document.getElementById("confirm-google-formula-changes");
  formulaCheckbox.checked = false;
  formulaLabel.hidden = formulaChanges === 0;
  document.getElementById("google-sheet-preview-section").hidden = false;
  document.getElementById("apply-google-sheet-edit").disabled = !changes.length || formulaChanges > 0;
}

function updateGoogleSheetApplyButton() {
  const applyButton = document.getElementById("apply-google-sheet-edit");
  if (!googleSheetProposal) {
    applyButton.disabled = true;
    return;
  }
  applyButton.disabled = !googleSheetProposal.changes.length
    || (googleSheetProposal.formulaChanges > 0
      && !document.getElementById("confirm-google-formula-changes").checked);
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

chrome.storage.local.get(["googleDataConnected"], ({ googleDataConnected }) => {
  document.getElementById("connect-google-btn").hidden = Boolean(googleDataConnected);
  document.getElementById("disconnect-google-btn").hidden = !googleDataConnected;
  document.getElementById("google-status").textContent = googleDataConnected
    ? "Google sources are connected for this Chrome profile."
    : "Connect an account to search its email, Docs, and Sheets.";
});

document.getElementById("connect-google-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const googleStatus = document.getElementById("google-status");
  button.disabled = true;
  googleStatus.textContent = "Waiting for Google authorization...";
  try {
    await sendRuntimeMessage({ type: "CONNECT_GOOGLE_DATA" });
    button.hidden = true;
    document.getElementById("disconnect-google-btn").hidden = false;
    googleStatus.textContent = "Google sources connected for this Chrome profile.";
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
    button.hidden = true;
    document.getElementById("connect-google-btn").hidden = false;
    googleSearchResults = [];
    currentGoogleSheet = null;
    googleSheetSnapshot = null;
    googleSheetProposal = null;
    document.getElementById("google-results").replaceChildren();
    document.getElementById("google-sheet-editor").hidden = true;
    document.getElementById("source-answer").textContent = "";
    updateAskSourcesButton();
    googleStatus.textContent = "Google tokens were cleared from this extension. Remove Exelidoc from your Google account permissions to revoke the grant completely.";
  } catch (error) {
    googleStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("load-google-sheet-range").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const statusEl = document.getElementById("google-sheet-edit-status");
  if (!currentGoogleSheet) return;
  button.disabled = true;
  statusEl.textContent = "Reading the selected range...";
  document.getElementById("google-sheet-preview-section").hidden = true;
  googleSheetProposal = null;
  try {
    const response = await sendRuntimeMessage({
      type: "READ_GOOGLE_SHEET_EDIT_RANGE",
      spreadsheetId: currentGoogleSheet.spreadsheetId,
      sheetTitle: document.getElementById("google-sheet-tab").value,
      range: document.getElementById("google-sheet-range").value.trim(),
    });
    googleSheetSnapshot = response.snapshot;
    document.getElementById("google-sheet-edit-controls").hidden = false;
    statusEl.textContent = `${googleSheetSnapshot.dimensions.rowCount} row(s) × ${googleSheetSnapshot.dimensions.columnCount} column(s) loaded.`;
  } catch (error) {
    googleSheetSnapshot = null;
    document.getElementById("google-sheet-edit-controls").hidden = true;
    statusEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("preview-google-sheet-edit").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const statusEl = document.getElementById("google-sheet-edit-status");
  const instruction = document.getElementById("google-sheet-instruction").value.trim();
  if (!googleSheetSnapshot || !instruction) {
    statusEl.textContent = "Load a range and enter the change you want.";
    return;
  }
  button.disabled = true;
  googleSheetProposal = null;
  document.getElementById("google-sheet-preview-section").hidden = true;
  statusEl.textContent = "Sending the selected range and instruction to Gemini...";
  try {
    const response = await sessionFetch("/api/ai/edit-range", {
      method: "POST",
      body: JSON.stringify({
        values: googleSheetSnapshot.values,
        instruction,
        source_url: currentGoogleSheet.url,
        source_urls: [currentGoogleSheet.url],
        client: "chrome",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gemini could not create an edit preview.");
    renderGoogleSheetProposal(data.correctedValues);
    statusEl.textContent = "Review every proposed change. No spreadsheet cells have been changed.";
    loadHistory();
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("confirm-google-formula-changes").addEventListener(
  "change",
  updateGoogleSheetApplyButton
);

document.getElementById("apply-google-sheet-edit").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const statusEl = document.getElementById("google-sheet-edit-status");
  if (!googleSheetSnapshot || !googleSheetProposal) return;
  const confirmedFormulas = document.getElementById("confirm-google-formula-changes").checked;
  if (
    googleSheetProposal.formulaChanges
    && (!confirmedFormulas || !window.confirm(
      `Apply ${googleSheetProposal.formulaChanges} reviewed formula change(s)?`
    ))
  ) {
    return;
  }

  button.disabled = true;
  statusEl.textContent = "Checking the sheet for newer edits and applying the approved preview...";
  try {
    const response = await sendRuntimeMessage({
      type: "APPLY_GOOGLE_SHEET_EDIT",
      snapshot: googleSheetSnapshot,
      correctedValues: googleSheetProposal.correctedValues,
      confirmFormulaChanges: confirmedFormulas,
    });
    googleSheetSnapshot.values = googleSheetProposal.correctedValues;
    document.getElementById("google-sheet-preview-section").hidden = true;
    document.getElementById("google-sheet-instruction").value = "";
    statusEl.textContent = `Applied ${response.updatedCells} cell change(s).`;
    googleSheetProposal = null;
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    updateGoogleSheetApplyButton();
  }
});

document.getElementById("discard-google-sheet-edit").addEventListener("click", () => {
  googleSheetProposal = null;
  document.getElementById("google-sheet-preview-section").hidden = true;
  document.getElementById("confirm-google-formula-changes").checked = false;
  document.getElementById("google-sheet-edit-status").textContent = "Preview discarded. The spreadsheet was not changed.";
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
        client: "chrome",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gemini could not answer this question.");
    document.getElementById("source-answer").textContent = data.generated || "Gemini returned no answer.";
    googleStatus.textContent = "Done. The source content was used for this answer and was not saved in Exelidoc history.";
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
