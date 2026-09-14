/* global Office, Excel, Word, PowerPoint, document, localStorage, setInterval, clearInterval */

// TODO: point this at your deployed Flask backend once it's hosted.
const BACKEND_URL = "http://localhost:5000";
const API_KEY_STORAGE_KEY = "exelidoc_api_key";

// TEMPORARY: single shared key for testing/personal use. Paste your actual
// key from Supabase below. Same caveat as background.js -- swap back to
// per-user keys before giving this to real paying users.
const DEFAULT_API_KEY = "paste-your-key-here";
const DEBOUNCE_MS = 1500;
const OUTLOOK_POLL_MS = 4000;

let debounceTimer = null;
let isApplyingCorrection = false; // guards against a write re-triggering its own change event
let lastCheckedText = "";         // skip redundant backend calls when nothing actually changed

Office.onReady((info) => {
  setupSettingsUI();
  const subtitle = document.querySelector(".subtitle");
  const hint = document.getElementById("hint");

  switch (info.host) {
    case Office.HostType.Excel:
      subtitle.textContent = "AI assistant for Excel";
      registerExcelHandlers();
      break;
    case Office.HostType.Word:
      subtitle.textContent = "AI assistant for Word";
      registerWordHandlers();
      break;
    case Office.HostType.PowerPoint:
      subtitle.textContent = "AI assistant for PowerPoint";
      registerPowerPointHandlers();
      break;
    case Office.HostType.Outlook:
      subtitle.textContent = "AI assistant for Outlook";
      hint.textContent = "Exelidoc checks your email as you compose. Unlike the other apps, this pane needs to stay open to keep checking.";
      registerOutlookHandlers();
      break;
    default:
      document.getElementById("status").textContent = "Unsupported host.";
  }
});

function setupSettingsUI() {
  const input = document.getElementById("api-key-input");
  input.value = localStorage.getItem(API_KEY_STORAGE_KEY) || "";
  document.getElementById("save-key-btn").addEventListener("click", () => {
    localStorage.setItem(API_KEY_STORAGE_KEY, input.value.trim());
    document.getElementById("status").textContent = "Key saved. Active -- watching for changes.";
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

/**
 * Shared backend call for free text (Word, PowerPoint, Outlook). Excel has
 * its own analyze-range call further down since it deals with a 2D grid.
 */
async function callAnalyzeText(text) {
  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus("No API key set -- paste your key above.");
    return null;
  }

  const response = await fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ text }),
  });

  if (response.status === 401) {
    setStatus("Invalid API key -- check the key above.");
    return null;
  }
  if (response.status === 402) {
    setStatus("Subscription not active.");
    return null;
  }
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);

  return response.json();
}

// ---------------------------------------------------------------------------
// Excel -- worksheets.onChanged fires on every cell edit, no polling needed.
// ---------------------------------------------------------------------------

async function registerExcelHandlers() {
  try {
    await Excel.run(async (context) => {
      context.workbook.worksheets.onChanged.add(onExcelChanged);
      await context.sync();
    });
    setStatus("Active -- watching for changes.");
  } catch (error) {
    setStatus("Error starting background monitor -- see console.");
    console.error(error);
  }
}

function onExcelChanged(event) {
  if (isApplyingCorrection) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => analyzeExcelRange(event.address, event.worksheetId), DEBOUNCE_MS);
}

async function analyzeExcelRange(address, worksheetId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus("No API key set -- paste your key above.");
    return;
  }

  try {
    const values = await Excel.run(async (context) => {
      const sheet = worksheetId
        ? context.workbook.worksheets.getItem(worksheetId)
        : context.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(address);
      range.load("values");
      await context.sync();
      return range.values;
    });

    setStatus("Checking...");
    const response = await fetch(`${BACKEND_URL}/api/ai/analyze-range`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({ values }),
    });

    if (response.status === 401) return setStatus("Invalid API key -- check the key above.");
    if (response.status === 402) return setStatus("Subscription not active.");
    if (!response.ok) throw new Error(`Backend returned ${response.status}`);

    const data = await response.json();

    isApplyingCorrection = true;
    await Excel.run(async (context) => {
      const sheet = worksheetId
        ? context.workbook.worksheets.getItem(worksheetId)
        : context.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(address);
      range.values = data.correctedValues;
      await context.sync();
    });

    setStatus("Active -- watching for changes.");
  } catch (error) {
    setStatus("Active -- last check failed, see console.");
    console.error(error);
  } finally {
    isApplyingCorrection = false;
  }
}

// ---------------------------------------------------------------------------
// Word -- no reliable "text changed" event exists across Word API versions,
// so this uses the cross-host common API's DocumentSelectionChanged event
// (fires when the cursor moves to a new paragraph/selection) and checks the
// current selection's text at that point. Good enough for "checks as you
// move through the document"; it won't catch edits mid-paragraph until you
// click elsewhere.
// ---------------------------------------------------------------------------

function registerWordHandlers() {
  Office.context.document.addHandlerAsync(
    Office.EventType.DocumentSelectionChanged,
    () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(analyzeWordSelection, DEBOUNCE_MS);
    },
    (result) => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        setStatus("Error starting background monitor -- see console.");
        console.error(result.error);
        return;
      }
      setStatus("Active -- watching for changes.");
    }
  );
}

async function analyzeWordSelection() {
  if (isApplyingCorrection) return;

  Word.run(async (context) => {
    const range = context.document.getSelection();
    range.load("text");
    await context.sync();

    const text = range.text.trim();
    if (!text || text === lastCheckedText) return;
    lastCheckedText = text;

    setStatus("Checking...");
    try {
      const data = await callAnalyzeText(text);
      if (!data) return;

      if (data.corrected && data.corrected !== text) {
        isApplyingCorrection = true;
        range.insertText(data.corrected, Word.InsertLocation.replace);
        await context.sync();
      }
      setStatus("Active -- watching for changes.");
    } catch (error) {
      setStatus("Active -- last check failed, see console.");
      console.error(error);
    } finally {
      isApplyingCorrection = false;
    }
  }).catch((error) => console.error(error));
}

// ---------------------------------------------------------------------------
// PowerPoint -- same DocumentSelectionChanged event, reading/writing the
// selected text box contents via the common API's text coercion.
// ---------------------------------------------------------------------------

function registerPowerPointHandlers() {
  Office.context.document.addHandlerAsync(
    Office.EventType.DocumentSelectionChanged,
    () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(analyzePowerPointSelection, DEBOUNCE_MS);
    },
    (result) => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        setStatus("Error starting background monitor -- see console.");
        console.error(result.error);
        return;
      }
      setStatus("Active -- watching for changes.");
    }
  );
}

function analyzePowerPointSelection() {
  if (isApplyingCorrection) return;

  Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, async (result) => {
    if (result.status === Office.AsyncResultStatus.Failed) return;

    const text = (result.value || "").trim();
    if (!text || text === lastCheckedText) return;
    lastCheckedText = text;

    setStatus("Checking...");
    try {
      const data = await callAnalyzeText(text);
      if (!data) return;

      if (data.corrected && data.corrected !== text) {
        isApplyingCorrection = true;
        Office.context.document.setSelectedDataAsync(data.corrected, { coercionType: Office.CoercionType.Text }, () => {
          isApplyingCorrection = false;
        });
      }
      setStatus("Active -- watching for changes.");
    } catch (error) {
      setStatus("Active -- last check failed, see console.");
      console.error(error);
      isApplyingCorrection = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Outlook -- there is no native "compose body changed" event, so this polls
// on an interval instead of reacting to an event. Known limitation: this
// only runs while the compose task pane is open (Outlook's ItemEdit form
// doesn't support the shared-runtime background pattern used above), so it
// isn't truly "background" the way the Excel/Word/PowerPoint version is.
// ---------------------------------------------------------------------------

function registerOutlookHandlers() {
  setStatus("Active -- watching for changes.");
  setInterval(pollOutlookBody, OUTLOOK_POLL_MS);
}

function pollOutlookBody() {
  if (isApplyingCorrection) return;

  Office.context.mailbox.item.body.getAsync(Office.CoercionType.Text, async (result) => {
    if (result.status === Office.AsyncResultStatus.Failed) return;

    const text = (result.value || "").trim();
    if (!text || text === lastCheckedText) return;
    lastCheckedText = text;

    setStatus("Checking...");
    try {
      const data = await callAnalyzeText(text);
      if (!data) return;

      if (data.corrected && data.corrected !== text) {
        isApplyingCorrection = true;
        Office.context.mailbox.item.body.setAsync(
          data.corrected,
          { coercionType: Office.CoercionType.Text },
          () => {
            isApplyingCorrection = false;
          }
        );
      }
      setStatus("Active -- watching for changes.");
    } catch (error) {
      setStatus("Active -- last check failed, see console.");
      console.error(error);
      isApplyingCorrection = false;
    }
  });
}
