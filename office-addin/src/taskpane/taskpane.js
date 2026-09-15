/* global Office, Excel, Word, PowerPoint, document, localStorage */

const BACKEND_URL = "https://exelidocv4-5.onrender.com";
const API_KEY_STORAGE_KEY = "exelidoc_api_key";
const DEFAULT_API_KEY = ""; // leave blank unless you intentionally want a shared fallback key

let currentHost = null;
let preEditSnapshot = null; // { kind: "word" | "powerpoint", data: ... } -- used by Undo

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
  const input = document.getElementById("api-key-input");
  input.value = localStorage.getItem(API_KEY_STORAGE_KEY) || "";
  document.getElementById("save-key-btn").addEventListener("click", () => {
    localStorage.setItem(API_KEY_STORAGE_KEY, input.value.trim());
    setStatus("Key saved.");
  });
}

function getApiKey() {
  const saved = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (saved) return saved;
  return DEFAULT_API_KEY === "paste-your-key-here" ? "" : DEFAULT_API_KEY;
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
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key set -- paste your key above.");

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(payload),
  });

  if (res.status === 401) throw new Error("invalid_api_key");
  if (res.status === 402) throw new Error("subscription_inactive");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request_failed (${res.status})`);
  }
  return res.json();
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