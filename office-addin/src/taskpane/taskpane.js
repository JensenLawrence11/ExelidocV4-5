/* global Office, Excel, Word, PowerPoint, document, localStorage */

const BACKEND_URL = "https://exelidocv4-5.onrender.com";
const SESSION_TOKEN_STORAGE_KEY = "exelidoc_session_token";

let currentHost = null;
let preEditSnapshot = null;
let pendingEdit = null;
let historyOffset = 0;

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
    case Office.HostType.Outlook:
      subtitle.textContent = "AI assistant for Outlook";
      document.getElementById("hint").textContent =
        "Shows a complete draft preview and waits for your approval before updating the body. It does not send email; formatting or signatures may change.";
      document.getElementById("ask").textContent = "Review email";
      document.getElementById("ask").addEventListener("click", onAskClicked);
      break;
    default:
      setStatus("Unsupported host.");
      textMode.hidden = true;
      rangeMode.hidden = true;
  }

  document.getElementById("undo").addEventListener("click", onUndoClicked);
  document.getElementById("apply-edit").addEventListener("click", onApplyEditClicked);
  document.getElementById("discard-edit").addEventListener("click", discardPendingEdit);
});

function setupSettingsUI() {
  const sessionToken = localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "";
  setAccountConnected(Boolean(sessionToken), localStorage.getItem("exelidoc_account_email") || "");

  document.getElementById("sign-in-btn").addEventListener("click", () => submitOfficeAuth("login"));
  document.getElementById("create-account-btn").addEventListener("click", () => submitOfficeAuth("signup-free"));
  document.getElementById("sign-out-btn").addEventListener("click", () => {
    localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    localStorage.removeItem("exelidoc_account_email");
    setAccountConnected(false);
    document.getElementById("history-list").textContent = "Sign in to view history.";
  });
  document.getElementById("save-password-btn").addEventListener("click", saveOfficePassword);

  document.getElementById("history-section").addEventListener("toggle", (event) => {
    if (event.currentTarget.open) loadHistory();
  });
  document.getElementById("refresh-history-btn").addEventListener("click", () => loadHistory());
  document.getElementById("load-more-history-btn").addEventListener("click", () => loadHistory(true));
  document.getElementById("clear-history-btn").addEventListener("click", clearHistory);
}

function setAccountConnected(connected, email = "") {
  document.getElementById("account-access").hidden = connected;
  document.getElementById("account-session").hidden = !connected;
  setAccountStatus(connected ? `Signed in${email ? ` as ${email}` : ""}.` : "Sign in or create an account to sync your history.");
}

async function submitOfficeAuth(endpoint) {
  const emailInput = document.getElementById("account-email-input");
  const passwordInput = document.getElementById("account-password-input");
  const button = document.getElementById(endpoint === "login" ? "sign-in-btn" : "create-account-btn");
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  if (!emailInput.validity.valid || !email) {
    setAccountStatus("Enter a valid email address.");
    return;
  }
  if (!passwordInput.validity.valid || password.length < 8 || password.length > 128) {
    setAccountStatus("Password must be between 8 and 128 characters.");
    return;
  }

  button.disabled = true;
  setAccountStatus(endpoint === "login" ? "Signing in..." : "Creating account...");
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not sign in");
    if (endpoint === "signup-free" && data.verification_required) {
      setAccountStatus(data.message);
      return;
    }
    if (!data.session_token) throw new Error(data.error || "Could not sign in");
    localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.session_token);
    localStorage.setItem("exelidoc_account_email", data.email);
    passwordInput.value = "";
    setAccountConnected(true, data.email);
  } catch (error) {
    setAccountStatus(error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveOfficePassword(event) {
  const button = event.currentTarget;
  const passwordInput = document.getElementById("new-password-input");
  const password = passwordInput.value;
  if (!passwordInput.validity.valid || password.length < 8 || password.length > 128) {
    setAccountStatus("Password must be between 8 and 128 characters.");
    return;
  }
  button.disabled = true;
  setAccountStatus("Saving password...");
  try {
    await callBackend("/api/auth/set-password", { password });
    passwordInput.value = "";
    setAccountStatus("Password saved. Use it to sign into your account on other devices.");
  } catch (error) {
    setAccountStatus(error.message);
  } finally {
    button.disabled = false;
  }
}

function setAccountStatus(text) {
  document.getElementById("account-status").textContent = text;
}

function renderHistory(items, append = false) {
  const list = document.getElementById("history-list");
  if (!append) list.replaceChildren();
  if (!items.length) {
    if (!append) list.textContent = "No saved requests yet.";
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "history-item";
    const metadata = document.createElement("div");
    metadata.className = "history-meta";
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

// ---------------------------------------------------------------------------
// Word + PowerPoint -- shared Ask button handler. Each host implements its
// own read/write pair below; this function just orchestrates them.
// ---------------------------------------------------------------------------

async function onAskClicked() {
  const askBtn = document.getElementById("ask");
  const instruction = document.getElementById("instruction").value.trim();
  if (!instruction) return;

  discardPendingEdit();
  preEditSnapshot = null;
  document.getElementById("undo").hidden = true;
  askBtn.disabled = true;
  setStatus("Thinking...");
  setNotes(null);

  try {
    const outlookDraft = currentHost === Office.HostType.Outlook
      ? await outlookGetDraft()
      : null;
    const existingText = currentHost === Office.HostType.Word
      ? await wordGetSelectedOrBodyText()
      : currentHost === Office.HostType.Outlook
        ? outlookDraft.text
        : await powerPointGetSelectedText();

    let result;
    if (existingText.trim()) {
      result = await callBackend("/api/ai/analyze-text", {
        text: existingText,
        instruction,
        source_url: Office.context.document.url || null,
      });
      if (!result.corrected || result.corrected === existingText) {
        setStatus("No changes suggested.");
        return;
      }
    } else {
      result = await callBackend("/api/ai/generate-text", {
        prompt: instruction,
        source_url: Office.context.document.url || null,
      });
    }

    const proposedText = existingText.trim() ? result.corrected : result.generated;
    if (typeof proposedText !== "string" || !proposedText.trim()) {
      throw new Error("The AI response did not contain text to preview.");
    }

    pendingEdit = {
      kind: currentHost,
      originalText: existingText,
      newText: proposedText,
      hadExistingText: Boolean(existingText.trim()),
      outlookDraft,
    };
    if (pendingEdit.kind === Office.HostType.Outlook) {
      pendingEdit.originalBody = outlookDraft.body;
    }

    showEditPreview(
      pendingEdit.newText,
      currentHost === Office.HostType.Outlook
        ? "Review the complete proposed draft. Exelidoc will not send it."
        : "Review the proposed text. The document has not been changed."
    );
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    askBtn.disabled = false;
  }
}

function showEditPreview(text, note) {
  document.getElementById("edit-preview-text").value = text;
  document.getElementById("edit-preview-note").textContent = note;
  document.getElementById("edit-preview").hidden = false;
  document.getElementById("apply-edit").disabled = false;
  setStatus("Review the preview, then apply it or discard it.");
}

function discardPendingEdit() {
  pendingEdit = null;
  document.getElementById("edit-preview-text").value = "";
  document.getElementById("edit-preview").hidden = true;
  setStatus("Preview discarded. The document was not changed.");
}

async function onApplyEditClicked() {
  if (!pendingEdit) {
    setStatus("Generate a new preview before applying changes.");
    return;
  }
  const applyButton = document.getElementById("apply-edit");
  applyButton.disabled = true;
  setStatus("Checking that the source has not changed...");

  try {
    const edit = pendingEdit;
    if (edit.kind === Office.HostType.Word) {
      const currentText = await wordGetSelectedOrBodyText();
      if (currentText !== edit.originalText) {
        throw new Error("The Word content changed after the preview. Generate a new preview before applying.");
      }
      if (edit.hadExistingText) {
        await wordApplyToSelectionOrBody(edit.newText);
      } else {
        await wordInsertAtCursor(edit.newText);
      }
      preEditSnapshot = {
        kind: "word",
        previousText: edit.originalText,
        appliedText: edit.newText,
      };
    } else if (edit.kind === Office.HostType.PowerPoint) {
      const currentText = await powerPointGetSelectedText();
      if (currentText !== edit.originalText) {
        throw new Error("The PowerPoint selection changed after the preview. Generate a new preview before applying.");
      }
      await powerPointSetSelectedText(edit.newText);
      preEditSnapshot = {
        kind: "powerpoint",
        previousText: edit.originalText,
        appliedText: edit.newText,
      };
    } else if (edit.kind === Office.HostType.Outlook) {
      const currentDraft = await outlookGetDraft();
      if (currentDraft.body !== edit.originalBody) {
        throw new Error("The Outlook draft changed after the preview. Generate a new preview before applying.");
      }
      await outlookSetBody(
        edit.newText,
        edit.outlookDraft.coercionType,
        edit.outlookDraft.bodyModeOptions
      );
      preEditSnapshot = {
        kind: "outlook",
        body: edit.originalBody,
        appliedBody: edit.outlookDraft.coercionType === Office.CoercionType.Html
          ? `<div>${escapeHtml(edit.newText).replace(/\r?\n/g, "<br>")}</div>`
          : edit.newText,
        coercionType: edit.outlookDraft.coercionType,
        bodyModeOptions: edit.outlookDraft.bodyModeOptions,
      };
    } else if (edit.kind === "excel") {
      const currentRange = await readExcelSelection();
      if (currentRange.address !== edit.address
        || JSON.stringify(currentRange.values) !== JSON.stringify(edit.values)
        || JSON.stringify(currentRange.formulas) !== JSON.stringify(edit.formulas)) {
        throw new Error("The Excel selection changed after the preview. Generate a new preview before applying.");
      }
      await writeSelectedExcelFormulas(edit.correctedFormulas);
      preEditSnapshot = {
        kind: "excel",
        address: edit.address,
        formulas: edit.formulas,
        appliedFormulas: edit.correctedFormulas,
      };
    }

    pendingEdit = null;
    document.getElementById("edit-preview").hidden = true;
    document.getElementById("undo").hidden = !preEditSnapshot;
    setStatus(currentHost === Office.HostType.Outlook
      ? "Draft updated. It has not been sent."
      : "Reviewed changes applied. Use Undo to restore the previous content.");
  } catch (err) {
    setStatus(`Could not apply preview: ${err.message}`);
  } finally {
    applyButton.disabled = false;
  }
}

async function onUndoClicked() {
  if (!preEditSnapshot) return;

  let restored = false;
  try {
    if (preEditSnapshot.kind === "word") {
      const currentText = await wordGetSelectedOrBodyText();
      if (currentText !== preEditSnapshot.appliedText) {
        throw new Error("The Word content changed after Exelidoc applied it. Undo was stopped to avoid overwriting newer changes.");
      }
      await wordApplyToSelectionOrBody(preEditSnapshot.previousText);
    } else if (preEditSnapshot.kind === "powerpoint") {
      const currentText = await powerPointGetSelectedText();
      if (currentText !== preEditSnapshot.appliedText) {
        throw new Error("The PowerPoint selection changed after Exelidoc applied it. Undo was stopped to avoid overwriting newer changes.");
      }
      await powerPointSetSelectedText(preEditSnapshot.previousText);
    } else if (preEditSnapshot.kind === "outlook") {
      const currentDraft = await outlookGetDraft();
      if (currentDraft.body !== preEditSnapshot.appliedBody) {
        throw new Error("The Outlook draft changed after Exelidoc applied it. Undo was stopped to avoid overwriting newer changes.");
      }
      await outlookWriteBody(
        preEditSnapshot.body,
        preEditSnapshot.coercionType,
        preEditSnapshot.bodyModeOptions
      );
    } else if (preEditSnapshot.kind === "excel") {
      const currentRange = await readExcelSelection();
      if (currentRange.address !== preEditSnapshot.address
        || JSON.stringify(currentRange.formulas) !== JSON.stringify(preEditSnapshot.appliedFormulas)) {
        throw new Error("The Excel selection changed after Exelidoc applied it. Undo was stopped to avoid overwriting newer changes.");
      }
      await writeSelectedExcelFormulas(preEditSnapshot.formulas);
    }
    restored = true;
    setStatus("Restored the previous content.");
  } catch (err) {
    setStatus(`Undo failed: ${err.message}`);
  } finally {
    if (restored) {
      preEditSnapshot = null;
      document.getElementById("undo").hidden = true;
    }
  }
}

function outlookGetDraft() {
  const body = Office.context.mailbox.item.body;
  const bodyModeOptions = Office.context.requirements.isSetSupported("Mailbox", "1.10")
    ? { bodyMode: Office.MailboxEnums.BodyMode.HostConfig }
    : {};
  return new Promise((resolve, reject) => {
    body.getTypeAsync((typeResult) => {
      if (typeResult.status === Office.AsyncResultStatus.Failed) {
        reject(new Error(typeResult.error.message));
        return;
      }

      const coercionType = typeResult.value;
      body.getAsync(coercionType, bodyModeOptions, (bodyResult) => {
        if (bodyResult.status === Office.AsyncResultStatus.Failed) {
          reject(new Error(bodyResult.error.message));
          return;
        }

        const originalBody = bodyResult.value || "";
        let text = originalBody;
        if (coercionType === Office.CoercionType.Html) {
          const parsedBody = new DOMParser().parseFromString(originalBody, "text/html").body;
          text = parsedBody.innerText || parsedBody.textContent;
        }
        resolve({ body: originalBody, coercionType, text: text || "", bodyModeOptions });
      });
    });
  });
}

function outlookSetBody(text, coercionType, bodyModeOptions = {}) {
  const content = coercionType === Office.CoercionType.Html
    ? `<div>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div>`
    : text;
  return outlookWriteBody(content, coercionType, bodyModeOptions);
}

function outlookWriteBody(content, coercionType, bodyModeOptions = {}) {
  const body = Office.context.mailbox.item.body;
  return new Promise((resolve, reject) => {
    body.setAsync(content, { coercionType, ...bodyModeOptions }, (result) => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        reject(new Error(result.error.message));
        return;
      }
      resolve();
    });
  });
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
  discardPendingEdit();
  preEditSnapshot = null;
  document.getElementById("undo").hidden = true;
  cleanBtn.disabled = true;
  setStatus("Reading selection...");
  setNotes(null);

  try {
    const selection = await readExcelSelection();
    const { values, formulas } = selection;

    if (!values || values.length === 0) {
      setStatus("No range selected.");
      return;
    }

    setStatus("Thinking...");
    const safeValues = values.map((row, rowIndex) => row.map((value, columnIndex) => (
      isFormulaCell(formulas[rowIndex][columnIndex]) ? "" : value
    )));
    const result = await callBackend("/api/ai/analyze-range", {
      values: safeValues,
      source_url: Office.context.document.url || null,
    });

    if (!result.correctedValues) {
      setStatus("No changes suggested.");
      return;
    }

    const correctedFormulas = formulas.map((row) => row.slice());
    for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < values[rowIndex].length; columnIndex += 1) {
        const currentValue = values[rowIndex][columnIndex];
        if (!isFormulaCell(formulas[rowIndex][columnIndex])
          && typeof currentValue === "string"
          && currentValue.trim()) {
          const proposedValue = result.correctedValues[rowIndex][columnIndex];
          if (typeof proposedValue !== "string" || proposedValue.trim().startsWith("=")) {
            throw new Error("A proposed cell value looked like a formula, so the range was not changed.");
          }
          correctedFormulas[rowIndex][columnIndex] = proposedValue;
        }
      }
    }

    if (JSON.stringify(correctedFormulas) === JSON.stringify(formulas)) {
      setStatus("No changes suggested.");
      return;
    }

    pendingEdit = {
      kind: "excel",
      address: selection.address,
      values,
      formulas,
      correctedFormulas,
    };
    showEditPreview(
      JSON.stringify(correctedFormulas, null, 2),
      "Formula cells and numbers are preserved. Review the proposed range; it has not been changed."
    );
    setNotes(result.notes);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    cleanBtn.disabled = false;
  }
}

async function readExcelSelection() {
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load("address,values,formulas");
    await context.sync();
    return {
      address: range.address,
      values: range.values,
      formulas: range.formulas,
    };
  });
}

function isFormulaCell(formula) {
  return typeof formula === "string" && formula.trimStart().startsWith("=");
}

async function writeSelectedExcelFormulas(formulas) {
  await Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.formulas = formulas;
    await context.sync();
  });
}