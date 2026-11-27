let sheetPanel = null;
let sheetLauncher = null;
let sheetInfo = null;
let sheetSnapshot = null;
let sheetProposal = null;
let sheetFormattingProposal = null;
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
      sheetFormattingProposal = null;
      sheetPanel.querySelector(".exelidoc-sheet-selection").textContent = "No cells selected for Exelidoc.";
      sheetPanel.querySelector(".exelidoc-sheet-preview").hidden = true;
      sheetPanel.querySelector(".exelidoc-sheet-format-preview").hidden = true;
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
    <div class="exelidoc-docs-note">Select cells, then use Create &amp; edit or Formatting. Review each preview before applying it.</div>
    <div class="exelidoc-sheet-selection" aria-live="polite">No cells selected for Exelidoc.</div>
    <button class="exelidoc-sheet-load" type="button">Select highlighted cells</button>
    <div class="exelidoc-sheet-tabs" role="tablist" aria-label="Sheets tools">
      <button id="exelidoc-sheet-edit-tab" class="exelidoc-sheet-tab" type="button" role="tab" aria-controls="exelidoc-sheet-edit-pane" aria-selected="true" data-sheet-pane="edit">Create &amp; edit</button>
      <button id="exelidoc-sheet-format-tab" class="exelidoc-sheet-tab" type="button" role="tab" aria-controls="exelidoc-sheet-format-pane" aria-selected="false" data-sheet-pane="formatting">Formatting</button>
    </div>
    <section id="exelidoc-sheet-edit-pane" class="exelidoc-sheet-pane" role="tabpanel" aria-labelledby="exelidoc-sheet-edit-tab" data-sheet-panel="edit">
      <label for="exelidoc-sheet-instruction">What would you like to make or change?</label>
      <textarea id="exelidoc-sheet-instruction" maxlength="10000" placeholder="e.g. Create a monthly budget table, add totals, or update the selected cells"></textarea>
      <div class="exelidoc-gmail-source-picker-slot"></div>
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
    </section>
    <section id="exelidoc-sheet-format-pane" class="exelidoc-sheet-pane exelidoc-sheet-format-pane" role="tabpanel" aria-labelledby="exelidoc-sheet-format-tab" data-sheet-panel="formatting" hidden>
      <p class="exelidoc-docs-note">Choose quick formats, or describe a custom style. Review the preview before applying.</p>
      <label for="exelidoc-sheet-format-scope">Apply formatting to</label>
      <select id="exelidoc-sheet-format-scope">
        <option value="range">Highlighted range</option>
        <option value="sheet">Entire active sheet</option>
      </select>
      <div class="exelidoc-sheet-format-grid" aria-label="Quick formatting options">
        <button class="exelidoc-sheet-format-option" type="button" data-format-option="headerStyle" aria-pressed="false">Style header row</button>
        <button class="exelidoc-sheet-format-option" type="button" data-format-option="alternatingRows" aria-pressed="false">Alternating row colors</button>
        <button class="exelidoc-sheet-format-option" type="button" data-format-option="freezeHeaderRow" aria-pressed="false">Freeze header row</button>
        <button class="exelidoc-sheet-format-option" type="button" data-format-option="autoResizeColumns" aria-pressed="false">Auto-fit columns</button>
        <button class="exelidoc-sheet-format-option" type="button" data-format-option="numberFormat" aria-pressed="false">Number format</button>
        <button class="exelidoc-sheet-format-option" type="button" data-format-option="borders" aria-pressed="false">Add borders</button>
      </div>
      <div class="exelidoc-sheet-number-format-control" hidden>
        <label for="exelidoc-sheet-number-format">Number style</label>
        <select id="exelidoc-sheet-number-format">
          <option value="CURRENCY">Currency</option>
          <option value="PERCENT">Percent</option>
          <option value="DATE">Date</option>
          <option value="NUMBER">Number</option>
        </select>
      </div>
      <label for="exelidoc-sheet-format-instruction">Describe any other formatting</label>
      <textarea id="exelidoc-sheet-format-instruction" maxlength="2000" placeholder="e.g. Use a dark blue header with bold white text and center the headings"></textarea>
      <button class="exelidoc-sheet-format-preview-button" type="button">Preview formatting</button>
      <section class="exelidoc-sheet-format-preview" hidden>
        <pre class="exelidoc-sheet-format-changes"></pre>
        <div class="exelidoc-docs-preview-actions">
          <button class="exelidoc-sheet-format-apply" type="button" disabled>Apply formatting</button>
          <button class="exelidoc-sheet-format-discard" type="button">Discard preview</button>
        </div>
      </section>
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
  const formatInstructionInput = panel.querySelector("#exelidoc-sheet-format-instruction");
  const formatScopeInput = panel.querySelector("#exelidoc-sheet-format-scope");
  const numberFormatInput = panel.querySelector("#exelidoc-sheet-number-format");
  const formatPreviewButton = panel.querySelector(".exelidoc-sheet-format-preview-button");
  const formatPreviewSection = panel.querySelector(".exelidoc-sheet-format-preview");
  const formatChangesPre = panel.querySelector(".exelidoc-sheet-format-changes");
  const formatApplyButton = panel.querySelector(".exelidoc-sheet-format-apply");
  const formatDiscardButton = panel.querySelector(".exelidoc-sheet-format-discard");
  const formatOptionButtons = Array.from(panel.querySelectorAll(".exelidoc-sheet-format-option"));
  const sheetTabs = Array.from(panel.querySelectorAll(".exelidoc-sheet-tab"));
  const sheetPanes = Array.from(panel.querySelectorAll(".exelidoc-sheet-pane"));
  const numberFormatControl = panel.querySelector(".exelidoc-sheet-number-format-control");
  const gmailSourcePicker = window.ExelidocGmailSourcePicker.mount(
    panel.querySelector(".exelidoc-gmail-source-picker-slot")
  );
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { refresh() {} };

  panel.querySelector(".exelidoc-close").addEventListener("click", () => setSheetPanelOpen(false));
  sheetTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const activePane = tab.dataset.sheetPane;
      sheetTabs.forEach((candidate) => {
        candidate.setAttribute("aria-selected", String(candidate === tab));
      });
      sheetPanes.forEach((pane) => {
        pane.hidden = pane.dataset.sheetPanel !== activePane;
      });
    });
  });
  formatOptionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const isPressed = button.getAttribute("aria-pressed") === "true";
      button.setAttribute("aria-pressed", String(!isPressed));
      if (button.dataset.formatOption === "numberFormat") {
        numberFormatControl.hidden = isPressed;
      }
    });
  });
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
    formatPreviewSection.hidden = true;
    sheetSnapshot = null;
    sheetProposal = null;
    sheetFormattingProposal = null;
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
      sheetFormattingProposal = null;
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

  formatPreviewButton.addEventListener("click", async () => {
    if (!sheetSnapshot) {
      status.textContent = "Select highlighted cells before previewing formatting.";
      return;
    }
    const options = { scope: formatScopeInput.value };
    formatOptionButtons.forEach((button) => {
      if (button.getAttribute("aria-pressed") !== "true") return;
      const option = button.dataset.formatOption;
      options[option] = option === "numberFormat" ? numberFormatInput.value : true;
    });
    const instruction = formatInstructionInput.value.trim();
    if (!instruction && !Object.keys(options).some((key) => key !== "scope")) {
      status.textContent = "Choose a quick format or describe the style you want.";
      return;
    }

    formatPreviewButton.disabled = true;
    formatPreviewSection.hidden = true;
    status.textContent = instruction
      ? "Creating a formatting preview with Gemini..."
      : "Preparing the formatting preview...";
    try {
      const response = await sendRuntimeMessage({
        type: "GENERATE_GOOGLE_SHEET_FORMATTING",
        snapshot: JSON.parse(JSON.stringify(sheetSnapshot)),
        instruction,
        options,
      });
      sheetFormattingProposal = {
        snapshot: JSON.parse(JSON.stringify(sheetSnapshot)),
        formatting: response.formatting,
        scope: response.scope,
        notes: response.notes || [],
      };
      renderFormattingProposal(sheetFormattingProposal);
      status.textContent = "Review the formatting preview. Nothing has been written.";
      if (instruction) history.refresh();
    } catch (error) {
      status.textContent = permissionMessage(error);
    } finally {
      formatPreviewButton.disabled = false;
    }
  });

  formatApplyButton.addEventListener("click", async () => {
    if (!sheetFormattingProposal) return;
    formatApplyButton.disabled = true;
    status.textContent = "Checking the selected cells and applying formatting...";
    try {
      const response = await sendRuntimeMessage({
        type: "APPLY_GOOGLE_SHEET_FORMATTING",
        snapshot: sheetFormattingProposal.snapshot,
        formatting: sheetFormattingProposal.formatting,
        scope: sheetFormattingProposal.scope,
      });
      sheetFormattingProposal = null;
      formatPreviewSection.hidden = true;
      formatInstructionInput.value = "";
      formatOptionButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
      numberFormatControl.hidden = true;
      status.textContent = `Applied ${response.formattingChanges} formatting change(s).`;
    } catch (error) {
      status.textContent = permissionMessage(error);
    } finally {
      formatApplyButton.disabled = !sheetFormattingProposal;
    }
  });

  formatDiscardButton.addEventListener("click", () => {
    sheetFormattingProposal = null;
    formatPreviewSection.hidden = true;
    status.textContent = "Formatting preview discarded. The spreadsheet was not changed.";
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

  function renderFormattingProposal(proposal) {
    const firstSelectedRow = proposal.snapshot.range.match(/^[A-Z]+(\d+)/i)?.[1] || "1";
    const labels = {
      headerStyle: "Style the first row as a header",
      alternatingRows: "Add alternating row colors",
      freezeHeaderRow: proposal.scope === "sheet"
        ? "Freeze through row 1"
        : `Freeze through row ${firstSelectedRow}`,
      autoResizeColumns: "Auto-fit the target columns",
      borders: "Add borders",
      bold: "Set selected text to bold",
      italic: "Set selected text to italic",
      wrapText: "Wrap selected cell text",
    };
    const disabledLabels = {
      bold: "Remove bold from selected text",
      italic: "Remove italics from selected text",
      wrapText: "Turn off text wrapping",
    };
    const changes = [
      `Target: ${proposal.scope === "sheet" ? "entire active sheet" : "highlighted range"}`,
    ];
    Object.entries(proposal.formatting).forEach(([key, value]) => {
      if (value == null) return;
      if (value === false) {
        if (disabledLabels[key]) changes.push(disabledLabels[key]);
        return;
      }
      if (key === "numberFormat") {
        changes.push(`Set number format to ${value.toLowerCase()}`);
      } else if (key === "fontSize" || key === "headerFontSize") {
        changes.push(`Set ${key === "fontSize" ? "selected text" : "header"} font size to ${value}`);
      } else if (key === "headerBackgroundColor" || key === "backgroundColor") {
        changes.push(`Set ${key === "headerBackgroundColor" ? "header" : "cell"} background to ${value}`);
      } else if (key === "headerTextColor" || key === "textColor") {
        changes.push(`Set ${key === "headerTextColor" ? "header" : "cell"} text color to ${value}`);
      } else if (key === "headerAlignment" || key === "horizontalAlignment") {
        changes.push(`Align ${key === "headerAlignment" ? "header" : "selected cells"} ${value.toLowerCase()}`);
      } else if (key === "headerStyle") {
        changes.push(labels[key]);
      } else if (labels[key]) {
        changes.push(labels[key]);
      }
    });
    proposal.notes.forEach((note) => changes.push(note));
    formatChangesPre.textContent = changes.join("\n");
    formatApplyButton.disabled = false;
    formatPreviewSection.hidden = false;
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
