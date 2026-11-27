let activePanel = null;
let docsLauncher = null;
const EXELIDOC_LOGO_URL = chrome.runtime.getURL("icons/favicon.ico");

function getCurrentDocumentId() {
  return window.location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] || null;
}

function ensureDocsLauncher() {
  if (docsLauncher) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "exelidoc-docs-launcher";
  button.innerHTML = `<img class="exelidoc-mark" src="${EXELIDOC_LOGO_URL}" alt="" /><span>Exelidoc</span>`;
  button.setAttribute("aria-label", "Open Exelidoc panel");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "exelidoc-docs-panel");
  button.addEventListener("click", () => {
    console.info("Exelidoc Docs: launcher clicked");
    if (activePanel && window.getComputedStyle(activePanel).display !== "none") {
      setDocsPanelOpen(false);
    } else {
      openDocsPanel();
    }
  });

  document.body.appendChild(button);
  docsLauncher = button;
}

function openDocsPanel() {
  if (!activePanel) activePanel = createExelidocPanel();
  setDocsPanelOpen(true);
  console.info("Exelidoc Docs: panel opened", { documentDetected: Boolean(getCurrentDocumentId()) });
}

function setDocsPanelOpen(isOpen) {
  if (!activePanel) return;
  activePanel.style.display = isOpen ? "flex" : "none";
  docsLauncher?.setAttribute("aria-expanded", String(isOpen));
  docsLauncher?.setAttribute("aria-label", isOpen ? "Close Exelidoc panel" : "Open Exelidoc panel");
}

function createExelidocPanel() {
  const panel = document.createElement("div");
  panel.className = "exelidoc-panel docs-mode";
  panel.id = "exelidoc-docs-panel";
  panel.innerHTML = `
    <div class="exelidoc-panel-header"><span class="exelidoc-brand"><img class="exelidoc-mark" src="${EXELIDOC_LOGO_URL}" alt="" />Exelidoc <span class="exelidoc-product-label">Docs</span></span><button class="exelidoc-close" type="button" aria-label="Close Exelidoc panel">&times;</button></div>
    <div class="exelidoc-docs-tabs" role="tablist" aria-label="Docs tools">
      <button id="exelidoc-docs-edit-tab" class="exelidoc-docs-tab" type="button" role="tab" aria-controls="exelidoc-docs-edit-pane" aria-selected="true" data-docs-pane="edit">Create &amp; edit</button>
      <button id="exelidoc-docs-format-tab" class="exelidoc-docs-tab" type="button" role="tab" aria-controls="exelidoc-docs-format-pane" aria-selected="false" data-docs-pane="formatting">Formatting</button>
    </div>
    <section id="exelidoc-docs-edit-pane" class="exelidoc-docs-pane" role="tabpanel" aria-labelledby="exelidoc-docs-edit-tab" data-docs-panel="edit">
      <textarea class="exelidoc-query" placeholder="e.g. write a section, rewrite this, make it more concise"></textarea>
      <div class="exelidoc-docs-note">Use Gmail emails as supporting context if helpful. Exelidoc will propose a full-document replacement for you to review.</div>
      <div class="exelidoc-gmail-source-picker-slot"></div>
      <button class="exelidoc-submit">Generate preview</button>
      <section class="exelidoc-docs-preview" hidden>
        <label for="exelidoc-docs-preview-text">Proposed full-document replacement</label>
        <textarea class="exelidoc-docs-preview-text" readonly></textarea>
        <div class="exelidoc-docs-preview-actions">
          <button class="exelidoc-docs-apply" type="button">Apply to document</button>
          <button class="exelidoc-docs-discard" type="button">Discard</button>
        </div>
      </section>
    </section>
    <section id="exelidoc-docs-format-pane" class="exelidoc-docs-pane" role="tabpanel" aria-labelledby="exelidoc-docs-format-tab" data-docs-panel="formatting" hidden>
      <p class="exelidoc-docs-note">Choose quick styles or describe a custom look. Formatting applies to the whole document and never replaces its text.</p>
      <div class="exelidoc-sheet-format-grid" aria-label="Quick document formatting">
        <button class="exelidoc-sheet-format-option" type="button" data-doc-format-option="title" aria-pressed="false">Style first paragraph as title</button>
        <button class="exelidoc-sheet-format-option" type="button" data-doc-format-option="body" aria-pressed="false">Readable body text</button>
        <button class="exelidoc-sheet-format-option" type="button" data-doc-format-option="center" aria-pressed="false">Center paragraphs</button>
        <button class="exelidoc-sheet-format-option" type="button" data-doc-format-option="justify" aria-pressed="false">Justify paragraphs</button>
        <button class="exelidoc-sheet-format-option" type="button" data-doc-format-option="spacing" aria-pressed="false">Add line spacing</button>
      </div>
      <label for="exelidoc-docs-format-instruction">Describe any other formatting</label>
      <textarea id="exelidoc-docs-format-instruction" class="exelidoc-docs-format-instruction" maxlength="2000" placeholder="e.g. Make section headings dark blue and bold, and set them to Heading 1"></textarea>
      <button class="exelidoc-docs-format-preview-button" type="button">Preview formatting</button>
      <section class="exelidoc-docs-format-preview" hidden>
        <pre class="exelidoc-docs-format-summary"></pre>
        <div class="exelidoc-docs-preview-actions">
          <button class="exelidoc-sheet-format-apply exelidoc-docs-format-apply" type="button" disabled>Apply formatting</button>
          <button class="exelidoc-sheet-format-discard exelidoc-docs-format-discard" type="button">Discard preview</button>
        </div>
      </section>
    </section>
    <button class="exelidoc-undo" hidden>Undo</button>
    <div class="exelidoc-status"></div>
    <details class="exelidoc-history">
      <summary>History</summary>
      <div class="exelidoc-history-content">
        <div class="exelidoc-history-status" role="status" aria-live="polite"></div>
        <div class="exelidoc-history-list"></div>
        <button class="exelidoc-history-more" type="button" hidden>Load older</button>
      </div>
    </details>
  `;

  const queryEl = panel.querySelector(".exelidoc-query");
  const submitEl = panel.querySelector(".exelidoc-submit");
  const previewEl = panel.querySelector(".exelidoc-docs-preview");
  const previewTextEl = panel.querySelector(".exelidoc-docs-preview-text");
  const applyEl = panel.querySelector(".exelidoc-docs-apply");
  const discardEl = panel.querySelector(".exelidoc-docs-discard");
  const undoEl = panel.querySelector(".exelidoc-undo");
  const statusEl = panel.querySelector(".exelidoc-status");
  const panelHeader = panel.querySelector(".exelidoc-panel-header");
  const formattingInstructionEl = panel.querySelector(".exelidoc-docs-format-instruction");
  const formattingPreviewButton = panel.querySelector(".exelidoc-docs-format-preview-button");
  const formattingPreviewEl = panel.querySelector(".exelidoc-docs-format-preview");
  const formattingSummaryEl = panel.querySelector(".exelidoc-docs-format-summary");
  const formattingApplyButton = panel.querySelector(".exelidoc-docs-format-apply");
  const formattingDiscardButton = panel.querySelector(".exelidoc-docs-format-discard");
  const formattingOptionButtons = Array.from(panel.querySelectorAll("[data-doc-format-option]"));
  const docsTabs = Array.from(panel.querySelectorAll(".exelidoc-docs-tab"));
  const docsPanes = Array.from(panel.querySelectorAll(".exelidoc-docs-pane"));
  const gmailSourcePicker = window.ExelidocGmailSourcePicker.mount(
    panel.querySelector(".exelidoc-gmail-source-picker-slot")
  );
  let pendingPreview = null;
  let pendingFormatting = null;
  let previousText = null;
  let undoRevisionId = null;
  panel.querySelector(".exelidoc-close").addEventListener("click", () => setDocsPanelOpen(false));
  docsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      docsTabs.forEach((candidate) => {
        candidate.setAttribute("aria-selected", String(candidate === tab));
      });
      docsPanes.forEach((pane) => {
        pane.hidden = pane.dataset.docsPanel !== tab.dataset.docsPane;
      });
    });
  });
  const clearFormattingPreview = () => {
    pendingFormatting = null;
    formattingPreviewEl.hidden = true;
    formattingApplyButton.disabled = true;
  };
  formattingOptionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const isPressed = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(isPressed));
      if (isPressed && ["center", "justify"].includes(button.dataset.docFormatOption)) {
        formattingOptionButtons
          .filter((candidate) => (
            candidate !== button
            && ["center", "justify"].includes(candidate.dataset.docFormatOption)
          ))
          .forEach((candidate) => candidate.setAttribute("aria-pressed", "false"));
      }
      clearFormattingPreview();
    });
  });
  formattingInstructionEl.addEventListener("input", clearFormattingPreview);
  formattingPreviewButton.addEventListener("click", () => {
    const documentId = getCurrentDocumentId();
    const quickOptions = formattingOptionButtons
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.dataset.docFormatOption);
    const instruction = formattingInstructionEl.value.trim();
    if (!documentId) {
      statusEl.textContent = "Open a Google Docs document and try again.";
      return;
    }
    if (!quickOptions.length && !instruction) {
      statusEl.textContent = "Choose a quick style or describe the formatting you want.";
      return;
    }

    formattingPreviewButton.disabled = true;
    clearFormattingPreview();
    statusEl.textContent = "Preparing formatting preview...";
    chrome.runtime.sendMessage(
      { type: "PREVIEW_GOOGLE_DOC_FORMATTING", documentId, quickOptions, instruction },
      (response) => {
        formattingPreviewButton.disabled = false;
        if (chrome.runtime.lastError || !response?.ok) {
          const error = response?.error || chrome.runtime.lastError?.message || "no response";
          statusEl.textContent = error === "no_session"
            ? "Sign in to Exelidoc from the toolbar popup first."
            : `Could not create formatting preview: ${error}`;
          return;
        }
        pendingFormatting = {
          formatting: response.formatting,
          revisionId: response.revisionId,
        };
        formattingSummaryEl.textContent = response.summary;
        formattingPreviewEl.hidden = false;
        formattingApplyButton.disabled = false;
        statusEl.textContent = "Review the formatting preview. Your document has not been changed.";
      }
    );
  });
  formattingApplyButton.addEventListener("click", () => {
    const documentId = getCurrentDocumentId();
    if (!documentId || !pendingFormatting) {
      statusEl.textContent = "Generate a new formatting preview before applying.";
      return;
    }
    formattingApplyButton.disabled = true;
    formattingDiscardButton.disabled = true;
    statusEl.textContent = "Applying the reviewed formatting...";
    chrome.runtime.sendMessage(
      {
        type: "APPLY_GOOGLE_DOC_FORMATTING",
        documentId,
        formatting: pendingFormatting.formatting,
        revisionId: pendingFormatting.revisionId,
      },
      (response) => {
        formattingApplyButton.disabled = false;
        formattingDiscardButton.disabled = false;
        if (chrome.runtime.lastError || !response?.ok) {
          statusEl.textContent = `Could not apply formatting: ${response?.error || chrome.runtime.lastError?.message || "no response"}`;
          return;
        }
        pendingFormatting = null;
        formattingPreviewEl.hidden = true;
        statusEl.textContent = "Done. The reviewed formatting was applied; document text was not changed.";
      }
    );
  });
  formattingDiscardButton.addEventListener("click", () => {
    clearFormattingPreview();
    formattingSummaryEl.textContent = "";
    statusEl.textContent = "Formatting preview discarded. Your document was not changed.";
  });
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { refresh: () => {} };
  if (!window.ExelidocHistory) {
    panel.querySelector(".exelidoc-history-status").textContent = "History helper not loaded. Reload Exelidoc from its updated extension folder.";
  }

  let dragState = null;
  panelHeader.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, textarea")) return;
    const rect = panel.getBoundingClientRect();
    panel.style.top = `${rect.top}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.bottom = "auto";
    panel.style.right = "auto";
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    panel.dataset.userMoved = "true";
    panel.setPointerCapture?.(event.pointerId);
  });

  panel.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    panel.style.left = `${dragState.left + dx}px`;
    panel.style.top = `${dragState.top + dy}px`;
    panel.style.right = "auto";
  });

  panel.addEventListener("pointerup", () => {
    dragState = null;
  });

  panel.addEventListener("pointerleave", () => {
    dragState = null;
  });

  submitEl.addEventListener("click", () => {
    const documentId = getCurrentDocumentId();
    const instruction = queryEl.value.trim();
    if (!documentId) {
      statusEl.textContent = "Open a Google Docs document and try again.";
      return;
    }
    if (!instruction) {
      statusEl.textContent = "Enter an instruction before clicking Ask.";
      return;
    }

    statusEl.textContent = "Thinking...";
    submitEl.disabled = true;
    previewEl.hidden = true;
    pendingPreview = null;
    console.info("Exelidoc Docs: sending Docs API request", { documentId });

    chrome.runtime.sendMessage(
      {
        type: "ANALYZE_GOOGLE_DOC",
        documentId,
        instruction,
        gmailSourceRefs: gmailSourcePicker.getSelectedRefs(),
      },
      (response) => {
        submitEl.disabled = false;
        if (chrome.runtime.lastError) {
          console.error("Exelidoc Docs: service worker message failed", chrome.runtime.lastError.message);
          statusEl.textContent = "Extension reloaded — refresh this page.";
          return;
        }
        if (!response || !response.ok) {
          console.warn("Exelidoc Docs: analysis request failed", response && response.error);
          if (response?.error === "no_session") {
            statusEl.textContent = "Sign in to Exelidoc from the toolbar popup first.";
          } else if (response?.error === "Google Docs OAuth is not configured for this extension.") {
            statusEl.textContent = "Google Docs OAuth is not configured. Add the extension OAuth client ID, then reload it.";
          } else {
            statusEl.textContent = `Error: ${response ? response.error : "no response"}`;
          }
          return;
        }
        console.info("Exelidoc Docs: Docs API request completed");
        history.refresh();
        if (!response.changed) {
          statusEl.textContent = "The document was unchanged.";
          return;
        }
        pendingPreview = {
          text: response.correctedText,
          revisionId: response.revisionId,
        };
        previewTextEl.value = response.correctedText;
        previewEl.hidden = false;
        const selectedTitles = gmailSourcePicker.getSelectedTitles();
        statusEl.textContent = selectedTitles.length
          ? `Review the proposed replacement. Included Gmail: ${selectedTitles.join("; ")}. Your document has not been changed.`
          : "Review the proposed replacement. Your document has not been changed.";
      }
    );
  });

  applyEl.addEventListener("click", () => {
    const documentId = getCurrentDocumentId();
    if (!documentId || !pendingPreview) {
      statusEl.textContent = "Generate a new preview before applying an edit.";
      return;
    }

    applyEl.disabled = true;
    discardEl.disabled = true;
    statusEl.textContent = "Applying the reviewed replacement...";
    chrome.runtime.sendMessage(
      {
        type: "APPLY_GOOGLE_DOC_EDIT",
        documentId,
        text: pendingPreview.text,
        revisionId: pendingPreview.revisionId,
      },
      (response) => {
        applyEl.disabled = false;
        discardEl.disabled = false;
        if (chrome.runtime.lastError || !response?.ok) {
          statusEl.textContent = `Could not apply the replacement: ${response?.error || chrome.runtime.lastError?.message || "no response"}`;
          return;
        }
        previousText = response.previousText;
        undoRevisionId = response.revisionId;
        pendingPreview = null;
        previewEl.hidden = true;
        undoEl.hidden = false;
        statusEl.textContent = "Done. The reviewed replacement was applied.";
      }
    );
  });

  discardEl.addEventListener("click", () => {
    pendingPreview = null;
    previewTextEl.value = "";
    previewEl.hidden = true;
    statusEl.textContent = "Preview discarded. Your document was not changed.";
  });

  undoEl.addEventListener("click", () => {
    const documentId = getCurrentDocumentId();
    if (!documentId || previousText === null || !undoRevisionId) return;
    undoEl.disabled = true;
    statusEl.textContent = "Restoring the previous document...";
    chrome.runtime.sendMessage(
      { type: "RESTORE_GOOGLE_DOC", documentId, text: previousText, revisionId: undoRevisionId },
      (response) => {
        undoEl.disabled = false;
        if (chrome.runtime.lastError || !response?.ok) {
          statusEl.textContent = `Could not restore the document: ${response?.error || chrome.runtime.lastError?.message || "no response"}`;
          return;
        }
        previousText = null;
        undoRevisionId = null;
        undoEl.hidden = true;
        statusEl.textContent = "Restored the previous document text.";
      }
    );
  });

  document.body.appendChild(panel);
  return panel;
}

function resetPanelState(panel) {
  panel.querySelector(".exelidoc-query").value = "";
  panel.querySelector(".exelidoc-status").textContent = "";
  panel.querySelector(".exelidoc-undo").hidden = true;
  panel.querySelector(".exelidoc-docs-preview").hidden = true;
  panel.dataset.userMoved = "false";
}

function initDocsPanel() {
  ensureDocsLauncher();
  console.info("Exelidoc Docs: content script ready", {
    documentDetected: Boolean(getCurrentDocumentId()),
    version: chrome.runtime.getManifest().version,
  });
}

initDocsPanel();
