/* global Office, Excel, Word, PowerPoint, document, localStorage */

const BACKEND_URL = "https://exelidocv4-5.onrender.com";
const SESSION_TOKEN_STORAGE_KEY = "exelidoc_session_token";

let currentHost = null;
let preEditSnapshot = null; // { kind: "word" | "powerpoint", data: ... } -- used by Undo
let historyOffset = 0;
const MAX_MENTIONED_HISTORY_ITEMS = 5;

Office.onReady((info) => {
  currentHost = info.host;
  setupSettingsUI();

  const subtitle = document.querySelector(".subtitle");
  const textMode = document.getElementById("text-mode");
  const rangeMode = document.getElementById("range-mode");

  switch (info.host) {
    case Office.HostType.Excel:
      subtitle.textContent = "AI assistant for Excel";
      textMode.hidden = true;
      rangeMode.hidden = false;
      document.getElementById("clean").addEventListener("click", onCleanRangeClicked);
      break;
    case Office.HostType.Word:
      subtitle.textContent = "AI assistant for Word";
      document.getElementById("ask").addEventListener("click", onAskClicked);
      break;
    case Office.HostType.PowerPoint:
      subtitle.textContent = "AI assistant for PowerPoint";
      document.getElementById("ask").addEventListener("click", onAskClicked);
      break;
    default:
      setStatus("Unsupported host.");
      textMode.hidden = true;
      rangeMode.hidden = true;
  }

  document.getElementById("undo").addEventListener("click", onUndoClicked);
});

function setupSettingsUI() {
  const linkCodeInput = document.getElementById("link-code-input");
  const connectButton = document.getElementById("connect-account-btn");
  const disconnectButton = document.getElementById("disconnect-account-btn");
  const createLinkCodeButton = document.getElementById("create-link-code-btn");
  const sessionToken = localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "";
  if (sessionToken) {
    setAccountConnected(true);
  } else {
    setAccountConnected(false);
  }

  connectButton.addEventListener("click", async () => {
    const code = linkCodeInput.value.trim();
    if (!code) {
      setAccountStatus("Enter a connection code from the Chrome extension.");
      return;
    }
    connectButton.disabled = true;
    setAccountStatus("Connecting...");
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/redeem-link-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();
      if (!response.ok || !data.session_token) throw new Error(data.error || "Could not connect account");
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.session_token);
      linkCodeInput.value = "";
      setAccountConnected(true, data.email);
    } catch (error) {
      setAccountStatus(error.message);
    } finally {
      connectButton.disabled = false;
    }
  });

  disconnectButton.addEventListener("click", () => {
    localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    setAccountConnected(false);
    document.getElementById("history-list").textContent = "Connect your account to view history.";
  });

  createLinkCodeButton.addEventListener("click", createOfficeLinkCode);

  document.getElementById("history-section").addEventListener("toggle", (event) => {
    if (event.currentTarget.open) loadHistory();
  });
  document.getElementById("refresh-history-btn").addEventListener("click", () => loadHistory());
  document.getElementById("load-more-history-btn").addEventListener("click", () => loadHistory(true));
  document.getElementById("clear-history-btn").addEventListener("click", clearHistory);
}

function setAccountConnected(connected, email = "") {
  document.getElementById("link-code-input").hidden = connected;
  document.getElementById("connect-account-btn").hidden = connected;
  document.getElementById("disconnect-account-btn").hidden = !connected;
  document.getElementById("create-link-code-btn").hidden = !connected;
  setAccountStatus(connected ? `Connected${email ? ` as ${email}` : ""}.` : "Connect using a code from Chrome.");
}

async function createOfficeLinkCode(event) {
  const button = event.currentTarget;
  const output = document.getElementById("link-code-status");
  button.disabled = true;
  output.textContent = "Creating code...";
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/link-code`, {
      method: "POST",
      headers: { "X-Session-Token": getSessionToken() },
    });
    const data = await response.json();
    if (!response.ok || !data.code) throw new Error(data.error || "Could not create a code");
    output.textContent = `Enter this code in the other app: ${data.code}`;
  } catch (error) {
    output.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function setAccountStatus(text) {
  document.getElementById("account-status").textContent = text;
}

function renderHistory(items, append = false) {
  const list = document.getElementById("history-list");
  const selectedIds = new Set(
    Array.from(list.querySelectorAll(".history-mention-checkbox:checked"))
      .map((checkbox) => checkbox.value)
  );
  if (!append) list.replaceChildren();
  if (!items.length) {
    if (!append) list.textContent = "No saved requests yet.";
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "history-item";
    const mentionLabel = document.createElement("label");
    mentionLabel.className = "history-mention";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "history-mention-checkbox";
    checkbox.value = item.id;
    checkbox.checked = selectedIds.has(item.id);
    checkbox.addEventListener("change", () => {
      const selected = list.querySelectorAll(".history-mention-checkbox:checked");
      if (selected.length > MAX_MENTIONED_HISTORY_ITEMS) {
        checkbox.checked = false;
        setStatus(`Choose up to ${MAX_MENTIONED_HISTORY_ITEMS} history items to mention.`);
      }
    });
    const checkboxLabel = document.createElement("span");
    checkboxLabel.textContent = "Mention in chat";
    mentionLabel.append(checkbox, checkboxLabel);

    const prompt = document.createElement("div");
    prompt.className = "history-prompt";
    prompt.textContent = item.prompt || item.action;
    const metadata = document.createElement("div");
    metadata.className = "history-meta";
    metadata.textContent = `${item.client} · ${new Date(item.created_at).toLocaleString()}`;

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "View reply";
    const response = document.createElement("pre");
    response.textContent = JSON.stringify(item.response, null, 2);
    details.append(summary, response);
    row.append(mentionLabel, prompt, metadata, details);
    list.append(row);
  });

}

async function loadHistory(append = false) {
  const list = document.getElementById("history-list");
  if (!getSessionToken()) {
    list.textContent = "Connect your account to view history.";
    return;
  }
  if (!append) {
    historyOffset = 0;
    list.textContent = "Loading history...";
  }
  try {
    const response = await fetch(`${BACKEND_URL}/api/history?limit=30&offset=${historyOffset}`, {
      headers: { "X-Session-Token": getSessionToken() },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load history");
    renderHistory(data.history || [], append);
    historyOffset += (data.history || []).length;
    document.getElementById("load-more-history-btn").hidden = !data.has_more;
  } catch (error) {
    list.textContent = error.message;
  }
}

async function clearHistory() {
  if (!getSessionToken()) return;
  if (!window.confirm("Delete all saved AI history from this account?")) return;
  try {
    const response = await fetch(`${BACKEND_URL}/api/history`, {
      method: "DELETE",
      headers: { "X-Session-Token": getSessionToken() },
    });
    if (!response.ok) throw new Error("Could not clear history");
    renderHistory([]);
    historyOffset = 0;
    document.getElementById("load-more-history-btn").hidden = true;
  } catch (error) {
    document.getElementById("history-list").textContent = error.message;
  }
}

function getSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "";
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function setNotes(notes) {
  const notesEl = document.getElementById("notes");
  if (!notes || !notes.length) {
    notesEl.innerHTML = "";
    return;
  }
  notesEl.innerHTML =
    "<strong>Changes made:</strong><ul>" +
    notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("") +
    "</ul>";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function callBackend(path, payload) {
  const sessionToken = getSessionToken();
  if (!sessionToken) throw new Error("No saved session. Sign in once to remember this account.");

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      ...payload,
      client: "office",
      history_ids: getSelectedHistoryIds(),
    }),
  });

  if (res.status === 401) throw new Error("invalid_session");
  if (res.status === 402) throw new Error("subscription_inactive");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request_failed (${res.status})`);
  }
  const result = await res.json();
  if (document.getElementById("history-section").open) loadHistory();
  return result;
}

function getSelectedHistoryIds() {
  return Array.from(document.querySelectorAll(".history-mention-checkbox:checked"))
    .map((checkbox) => checkbox.value);
}

// ---------------------------------------------------------------------------
// Word + PowerPoint -- shared Ask button handler. Each host implements its
// own read/write pair below; this function just orchestrates them.
// ---------------------------------------------------------------------------

async function onAskClicked() {
  const askBtn = document.getElementById("ask");
  const instruction = document.getElementById("instruction").value.trim();
  if (!instruction) return;

  askBtn.disabled = true;
  setStatus("Thinking...");
  setNotes(null);

  try {
    const existingText =
      currentHost === Office.HostType.Word
        ? await wordGetSelectedOrBodyText()
        : await powerPointGetSelectedText();

    let result;
    if (existingText.trim()) {
      result = await callBackend("/api/ai/analyze-text", { text: existingText, instruction });
      if (!result.corrected || result.corrected === existingText) {
        setStatus("No changes suggested.");
        return;
      }
      if (currentHost === Office.HostType.Word) {
        preEditSnapshot = { kind: "word", text: existingText };
        await wordApplyToSelectionOrBody(result.corrected);
      } else {
        preEditSnapshot = { kind: "powerpoint", text: existingText };
        await powerPointSetSelectedText(result.corrected);
      }
    } else {
      result = await callBackend("/api/ai/generate-text", { prompt: instruction });
      preEditSnapshot = null; // nothing to undo back to -- there was no prior text
      if (currentHost === Office.HostType.Word) {
        await wordInsertAtCursor(result.generated);
      } else {
        await powerPointSetSelectedText(result.generated);
      }
    }

    document.getElementById("undo").hidden = !preEditSnapshot;
    setStatus("Done. Use Ctrl+Z / Cmd+Z to undo, or the Undo button below.");
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    askBtn.disabled = false;
  }
}

async function onUndoClicked() {
  if (!preEditSnapshot) return;

  try {
    if (preEditSnapshot.kind === "word") {
      await wordApplyToSelectionOrBody(preEditSnapshot.text);
    } else if (preEditSnapshot.kind === "powerpoint") {
      await powerPointSetSelectedText(preEditSnapshot.text);
    } else if (preEditSnapshot.kind === "excel") {
      await Excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.values = preEditSnapshot.values;
        await context.sync();
      });
    }
    setStatus("Restored previous text.");
  } catch (err) {
    setStatus(`Undo failed: ${err.message}`);
  } finally {
    preEditSnapshot = null;
    document.getElementById("undo").hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

function wordGetSelectedOrBodyText() {
  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    selection.load("text");
    await context.sync();
    if (selection.text && selection.text.trim()) return selection.text;

    const body = context.document.body;
    body.load("text");
    await context.sync();
    return body.text;
  });
}

// Re-reads the CURRENT selection at write time rather than reusing a range
// object captured earlier -- if it's non-empty, replace it; otherwise this
// was a whole-body operation, so replace the whole body instead. This
// keeps the edit anchored to the same place the text actually came from.
function wordApplyToSelectionOrBody(newText) {
  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    selection.load("text");
    await context.sync();

    if (selection.text && selection.text.trim()) {
      selection.insertText(newText, Word.InsertLocation.replace);
    } else {
      const body = context.document.body;
      body.clear();
      body.insertText(newText, Word.InsertLocation.start);
    }
    await context.sync();
  });
}

function wordInsertAtCursor(text) {
  return Word.run(async (context) => {
    context.document.getSelection().insertText(text, Word.InsertLocation.replace);
    await context.sync();
  });
}

// ---------------------------------------------------------------------------
// PowerPoint -- uses the older common Office.context.document API (Office.js
// doesn't have a dedicated PowerPoint.run text API the way Word/Excel do).
// ---------------------------------------------------------------------------

function powerPointGetSelectedText() {
  return new Promise((resolve, reject) => {
    Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, (result) => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        reject(new Error(result.error.message));
        return;
      }
      resolve(result.value || "");
    });
  });
}

function powerPointSetSelectedText(text) {
  return new Promise((resolve, reject) => {
    Office.context.document.setSelectedDataAsync(
      text,
      { coercionType: Office.CoercionType.Text },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Failed) {
          reject(new Error(result.error.message));
          return;
        }
        resolve();
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Excel -- single "Clean Up" button, no instruction (backend doesn't accept
// one for ranges yet -- see analyze_spreadsheet_range in ai_service.py).
// ---------------------------------------------------------------------------

async function onCleanRangeClicked() {
  const cleanBtn = document.getElementById("clean");
  cleanBtn.disabled = true;
  setStatus("Reading selection...");
  setNotes(null);

  try {
    const values = await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load("values");
      await context.sync();
      return range.values;
    });

    if (!values || values.length === 0) {
      setStatus("No range selected.");
      return;
    }

    setStatus("Thinking...");
    const result = await callBackend("/api/ai/analyze-range", { values });

    if (!result.correctedValues) {
      setStatus("No changes suggested.");
      return;
    }

    preEditSnapshot = { kind: "excel", values };
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.values = result.correctedValues;
      await context.sync();
    });

    document.getElementById("undo").hidden = false;
    setStatus("Done. Use Ctrl+Z / Cmd+Z to undo, or the Undo button below.");
    setNotes(result.notes);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    cleanBtn.disabled = false;
  }
}