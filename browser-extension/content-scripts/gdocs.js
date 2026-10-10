let activePanel = null;
let docsLauncher = null;

function getCurrentDocumentId() {
  return window.location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] || null;
}

function ensureDocsLauncher() {
  if (docsLauncher) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "exelidoc-docs-launcher";
  button.textContent = "Exelidoc";
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
    <div class="exelidoc-panel-header"><span>Exelidoc</span><button class="exelidoc-close" type="button" aria-label="Close Exelidoc panel">&times;</button></div>
    <textarea class="exelidoc-query" placeholder="e.g. write a section, rewrite this, make it more concise"></textarea>
    <div class="exelidoc-docs-note">Rewrites the full plain-text document. Formatting resets; tables and embedded objects are unsupported.</div>
    <button class="exelidoc-submit">Ask</button>
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
  const undoEl = panel.querySelector(".exelidoc-undo");
  const statusEl = panel.querySelector(".exelidoc-status");
  const panelHeader = panel.querySelector(".exelidoc-panel-header");
  let previousText = null;
  panel.querySelector(".exelidoc-close").addEventListener("click", () => setDocsPanelOpen(false));
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { selectedIds: () => [], refresh: () => {} };
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
    console.info("Exelidoc Docs: sending Docs API request", { documentId });

    chrome.runtime.sendMessage(
      { type: "ANALYZE_GOOGLE_DOC", documentId, instruction, historyIds: history.selectedIds() },
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
        previousText = response.previousText;
        undoEl.hidden = false;
        statusEl.textContent = "Done. The document was updated.";
      }
    );
  });

  undoEl.addEventListener("click", () => {
    const documentId = getCurrentDocumentId();
    if (!documentId || previousText === null) return;
    undoEl.disabled = true;
    statusEl.textContent = "Restoring the previous document...";
    chrome.runtime.sendMessage(
      { type: "RESTORE_GOOGLE_DOC", documentId, text: previousText },
      (response) => {
        undoEl.disabled = false;
        if (chrome.runtime.lastError || !response?.ok) {
          statusEl.textContent = `Could not restore the document: ${response?.error || chrome.runtime.lastError?.message || "no response"}`;
          return;
        }
        previousText = null;
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
