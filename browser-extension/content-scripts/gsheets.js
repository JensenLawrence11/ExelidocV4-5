let sheetPanel = null;
let sheetLauncher = null;
let sheetInfo = null;
let sheetSnapshot = null;
let sheetProposal = null;
const EXELIDOC_LOGO_URL = chrome.runtime.getURL("icons/favicon.ico");

function getCurrentSpreadsheetId() {
  return window.location.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] || null;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Extension reloaded. Refresh this sheet."));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "No response from Exelidoc."));
        return;
      }
      resolve(response);
    });
  });
}

function permissionMessage(error) {
  if (/authorization|permission|scope|403|not authorized/i.test(error.message)) {
    return `${error.message}\nGoogle Sheets editing requires the Sheets API and edit access for this account. Approve Google's authorization prompt when applying an edit.`;
  }
  return error.message;
}

function getHighlightedRange() {
  const nameBox = document.querySelector("#t-name-box")
    || document.querySelector('input[aria-label="Name box"]')
    || document.querySelector('[aria-label="Name box"][contenteditable="true"]');
  const value = nameBox?.value || nameBox?.textContent || "";
  const match = value.trim().match(/(?:^|!)(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)$/i);
  return match ? match[1].replace(/\$/g, "").toUpperCase() : null;
}

function getHighlightedSheetTitle() {
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  const labels = [activeTab?.getAttribute("aria-label"), activeTab?.textContent]
    .filter(Boolean)
    .map((label) => label.trim());
  const activeSheet = sheetInfo?.sheets.find((sheet) => labels.some((label) => (
    label === sheet.title || label.startsWith(`${sheet.title},`)
  )));
  if (activeSheet) return activeSheet.title;
  return sheetInfo?.sheets.length === 1 ? sheetInfo.sheets[0].title : null;
}

function setSheetPanelOpen(isOpen) {
  if (!sheetPanel) return;
  sheetPanel.style.display = isOpen ? "flex" : "none";
  sheetLauncher?.setAttribute("aria-expanded", String(isOpen));
}

function ensureSheetLauncher() {
  if (sheetLauncher) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "exelidoc-docs-launcher exelidoc-sheet-launcher";
  button.innerHTML = `<img class="exelidoc-mark" src="${EXELIDOC_LOGO_URL}" alt="" /><span>Exelidoc</span>`;
  button.setAttribute("aria-label", "Open Exelidoc Sheets panel");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", async () => {
    const isOpen = sheetPanel && window.getComputedStyle(sheetPanel).display !== "none";
    if (isOpen) {
      setSheetPanelOpen(false);
      return;
    }
    if (!sheetPanel) sheetPanel = createSheetPanel();
    setSheetPanelOpen(true);
    if (sheetInfo?.spreadsheetId !== getCurrentSpreadsheetId()) {
      sheetInfo = null;
      sheetSnapshot = null;
      sheetProposal = null;
      sheetPanel.querySelector(".exelidoc-sheet-selection").textContent = "No cells selected for Exelidoc.";
      await loadSheetInfo();
    }
  });
  document.body.appendChild(button);
  sheetLauncher = button;
}

function createSheetPanel() {
  const panel = document.createElement("section");
  panel.className = "exelidoc-panel docs-mode exelidoc-sheet-panel";
  panel.innerHTML = `
    <div class="exelidoc-panel-header"><span class="exelidoc-brand"><img class="exelidoc-mark" src="${EXELIDOC_LOGO_URL}" alt="" />Exelidoc <span class="exelidoc-product-label">Sheets</span></span><button class="exelidoc-close" type="button" aria-label="Close Exelidoc panel">&times;</button></div>
    <div class="exelidoc-docs-note">Highlight cells in the sheet, then choose them for Exelidoc. Describe what to make or change. Nothing is written until you review and apply the preview.</div>
    <div class="exelidoc-gmail-source-picker-slot"></div>
    <div class="exelidoc-sheet-selection" aria-live="polite">No cells selected for Exelidoc.</div>
    <button class="exelidoc-sheet-load" type="button">Select highlighted cells</button>
    <label for="exelidoc-sheet-instruction">What would you like to make or change?</label>
    <textarea id="exelidoc-sheet-instruction" maxlength="10000" placeholder="e.g. Create a monthly budget table, add totals, or update the selected cells"></textarea>
    <button class="exelidoc-submit" type="button">Generate preview</button>
    <section class="exelidoc-sheet-preview" hidden>
      <pre class="exelidoc-sheet-changes"></pre>
      <label class="exelidoc-sheet-formula-confirm" hidden>
        <input type="checkbox" />
        I reviewed and approve the formula changes shown above.
      </label>
      <div class="exelidoc-docs-preview-actions">
        <button class="exelidoc-sheet-apply" type="button" disabled>Apply approved changes</button>
        <button class="exelidoc-sheet-discard" type="button">Discard preview</button>
      </div>
    </section>
    <div class="exelidoc-status" role="status" aria-live="polite"></div>
    <details class="exelidoc-history">
      <summary>History</summary>
      <div class="exelidoc-history-content">
        <div class="exelidoc-history-status" role="status" aria-live="polite"></div>
        <div class="exelidoc-history-list"></div>
        <button class="exelidoc-history-more" type="button" hidden>Load older</button>
      </div>
    </details>
  `;
  const status = panel.querySelector(".exelidoc-status");
  const selectionLabel = panel.querySelector(".exelidoc-sheet-selection");
  const instructionInput = panel.querySelector("#exelidoc-sheet-instruction");
  const loadButton = panel.querySelector(".exelidoc-sheet-load");
  const previewButton = panel.querySelector(".exelidoc-submit");
  const previewSection = panel.querySelector(".exelidoc-sheet-preview");
  const changesPre = panel.querySelector(".exelidoc-sheet-changes");
  const formulaLabel = panel.querySelector(".exelidoc-sheet-formula-confirm");
  const formulaCheckbox = formulaLabel.querySelector("input");
  const applyButton = panel.querySelector(".exelidoc-sheet-apply");
  const discardButton = panel.querySelector(".exelidoc-sheet-discard");
  const gmailSourcePicker = window.ExelidocGmailSourcePicker.mount(
    panel.querySelector(".exelidoc-gmail-source-picker-slot")
  );
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { refresh() {} };

  panel.querySelector(".exelidoc-close").addEventListener("click", () => setSheetPanelOpen(false));
  formulaCheckbox.addEventListener("change", updateApplyButton);
  loadButton.addEventListener("click", async () => {
    const spreadsheetId = getCurrentSpreadsheetId();
    if (!spreadsheetId || !sheetInfo) {
      status.textContent = "Open a Google Sheets spreadsheet and try again.";
      return;
    }
    const range = getHighlightedRange();
    const sheetTitle = getHighlightedSheetTitle();
    if (!range || !sheetTitle) {
      status.textContent = "Highlight cells in the sheet first, then click Select highlighted cells.";
      return;
    }
    loadButton.disabled = true;
    previewSection.hidden = true;
    sheetSnapshot = null;
    sheetProposal = null;
    selectionLabel.textContent = "No cells selected for Exelidoc.";
    status.textContent = `Reading ${sheetTitle}!${range}...`;
    try {
      const response = await sendRuntimeMessage({
        type: "READ_GOOGLE_SHEET_EDIT_RANGE",
        spreadsheetId,
        sheetTitle,
        range,
      });
      sheetSnapshot = response.snapshot;
      sheetProposal = null;
      selectionLabel.textContent = `Selected for Exelidoc: ${sheetTitle}!${range}`;
      status.textContent = `${sheetSnapshot.dimensions.rowCount} row(s) by ${sheetSnapshot.dimensions.columnCount} column(s) ready.`;
    } catch (error) {
      sheetSnapshot = null;
      status.textContent = permissionMessage(error);
    } finally {
      loadButton.disabled = false;
    }
  });

  previewButton.addEventListener("click", async () => {
    const instruction = instructionInput.value.trim();
    if (!sheetSnapshot || !instruction) {
      status.textContent = "Select highlighted cells and enter what you want to make or change.";
      return;
    }
    previewButton.disabled = true;
    previewSection.hidden = true;
    status.textContent = "Sending the selected range and instruction to Gemini...";
    try {
      const response = await sendRuntimeMessage({
        type: "GENERATE_GOOGLE_SHEET_EDIT",
        snapshot: sheetSnapshot,
        instruction,
        gmailSourceRefs: gmailSourcePicker.getSelectedRefs(),
      });
      renderProposal(response.data.correctedValues);
      const selectedTitles = gmailSourcePicker.getSelectedTitles();
      status.textContent = selectedTitles.length
        ? `Review the proposed cell changes. Included Gmail: ${selectedTitles.join("; ")}. Nothing has been written.`
        : "Review the proposed cell changes. Nothing has been written.";
      history.refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      previewButton.disabled = false;
    }
  });

  applyButton.addEventListener("click", async () => {
    if (!sheetSnapshot || !sheetProposal) return;
    if (sheetProposal.formulaChanges > 0) {
      if (!formulaCheckbox.checked) {
        status.textContent = "Review and confirm the formula changes before applying.";
        return;
      }
      if (!window.confirm(`Apply ${sheetProposal.formulaChanges} reviewed formula change(s)?`)) return;
    }
    applyButton.disabled = true;
    status.textContent = "Checking the sheet for newer edits and applying the preview...";
    try {
      const response = await sendRuntimeMessage({
        type: "APPLY_GOOGLE_SHEET_EDIT",
        snapshot: sheetSnapshot,
        correctedValues: sheetProposal.correctedValues,
        confirmFormulaChanges: formulaCheckbox.checked,
      });
      sheetSnapshot.values = sheetProposal.correctedValues;
      sheetProposal = null;
      previewSection.hidden = true;
      instructionInput.value = "";
      status.textContent = `Applied ${response.updatedCells} cell change(s).`;
    } catch (error) {
      status.textContent = permissionMessage(error);
    } finally {
      updateApplyButton();
    }
  });

  discardButton.addEventListener("click", () => {
    sheetProposal = null;
    previewSection.hidden = true;
    formulaCheckbox.checked = false;
    status.textContent = "Preview discarded. The spreadsheet was not changed.";
  });

  function renderProposal(correctedValues) {
    if (
      !Array.isArray(correctedValues)
      || correctedValues.length !== sheetSnapshot.values.length
      || correctedValues.some((row, index) => (
        !Array.isArray(row) || row.length !== sheetSnapshot.values[index].length
      ))
    ) {
      throw new Error("Gemini returned a spreadsheet preview with an invalid shape.");
    }
    const changes = [];
    let formulaChanges = 0;
    sheetSnapshot.values.forEach((row, rowIndex) => {
      row.forEach((before, columnIndex) => {
        const after = correctedValues[rowIndex][columnIndex];
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        const formulaChange = isFormula(before) || isFormula(after);
        if (formulaChange) formulaChanges += 1;
        changes.push(`${cellAddress(sheetSnapshot, rowIndex, columnIndex)}${formulaChange ? " [FORMULA]" : ""}: ${displayValue(before)} -> ${displayValue(after)}`);
      });
    });
    sheetProposal = { correctedValues, formulaChanges, hasChanges: changes.length > 0 };
    changesPre.textContent = changes.length
      ? changes.slice(0, 100).join("\n") + (changes.length > 100 ? `\n...and ${changes.length - 100} more change(s).` : "")
      : "Gemini proposed no cell changes.";
    formulaCheckbox.checked = false;
    formulaLabel.hidden = formulaChanges === 0;
    previewSection.hidden = false;
    updateApplyButton();
  }

  function updateApplyButton() {
    applyButton.disabled = !sheetProposal?.hasChanges
      || (sheetProposal.formulaChanges > 0 && !formulaCheckbox.checked);
  }

  document.body.appendChild(panel);
  return panel;
}

async function loadSheetInfo() {
  const status = sheetPanel?.querySelector(".exelidoc-status");
  const spreadsheetId = getCurrentSpreadsheetId();
  if (!spreadsheetId || !status) return;
  status.textContent = "Checking Google Sheets access...";
  try {
    sheetInfo = await sendRuntimeMessage({ type: "GET_GOOGLE_SHEET_INFO", spreadsheetId });
    status.textContent = `${sheetInfo.title} is ready. Highlight cells to begin.`;
  } catch (error) {
    sheetInfo = null;
    status.textContent = permissionMessage(error);
  }
}

function isFormula(value) {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

function displayValue(value) {
  return value == null ? "(blank)" : JSON.stringify(value);
}

function cellAddress(snapshot, row, column) {
  const start = snapshot.range.split(":")[0].match(/^([A-Z]+)(\d+)$/i);
  if (!start) return `row ${row + 1}, column ${column + 1}`;
  let columnNumber = start[1].toUpperCase().split("").reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0
  ) + column;
  let letters = "";
  while (columnNumber > 0) {
    columnNumber -= 1;
    letters = String.fromCharCode(65 + (columnNumber % 26)) + letters;
    columnNumber = Math.floor(columnNumber / 26);
  }
  return `${letters}${Number(start[2]) + row}`;
}

ensureSheetLauncher();
