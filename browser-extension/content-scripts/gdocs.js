let activePanel = null;
let activeBox = null;
let preEditSnapshot = null;
let docsLauncher = null;
let boundEditor = null;

function getDocsEditor() {
  const editor = document.querySelector('.kix-appview-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]');
  if (editor) return editor;

  for (const frame of document.querySelectorAll("iframe.docs-texteventtarget-iframe")) {
    try {
      const frameEditor = frame.contentDocument?.body;
      if (frameEditor?.isContentEditable || frameEditor?.getAttribute("contenteditable") === "true") {
        return frameEditor;
      }
    } catch (error) {
      console.debug("Exelidoc Docs: editor iframe is not accessible", error);
    }
  }

  return null;
}

function captureComposeSnapshot(box) {
  if (!box) return null;

  return {
    html: box.innerHTML,
    text: box.textContent || box.innerText || "",
  };
}

function setComposeText(box, value) {
  if (!box) return;

  box.focus();
  const editorDocument = box.ownerDocument || document;
  const selection = editorDocument.getSelection();
  if (selection) {
    const range = editorDocument.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return editorDocument.execCommand("insertText", false, value || "");
}

function restoreComposeSnapshot(box, snapshot) {
  if (!box || !snapshot) return;

  box.focus();

  setComposeText(box, snapshot.text || "");
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
  const editor = getDocsEditor();
  if (editor && editor !== activeBox) setActiveBox(editor);
  if (!activePanel) activePanel = createExelidocPanel();
  setDocsPanelOpen(true);
  console.info("Exelidoc Docs: panel opened", { editorDetected: Boolean(activeBox) });
  if (!activeBox) {
    activePanel.querySelector(".exelidoc-status").textContent = "Click in the document to connect Exelidoc.";
  }
}

function setDocsPanelOpen(isOpen) {
  if (!activePanel) return;
  activePanel.style.display = isOpen ? "flex" : "none";
  docsLauncher?.setAttribute("aria-expanded", String(isOpen));
  docsLauncher?.setAttribute("aria-label", isOpen ? "Close Exelidoc panel" : "Open Exelidoc panel");
}

function setActiveBox(box) {
  const sameBox = activeBox === box;
  activeBox = box;

  if (!box) {
    preEditSnapshot = null;
    setDocsPanelOpen(false);
    return;
  }

  if (sameBox) return;
  preEditSnapshot = null;

  if (!activePanel) activePanel = createExelidocPanel();
  resetPanelState(activePanel);
  positionPanel(activePanel, box);
}

function positionPanel(panel, box) {
  if (!panel) return;
  panel.classList.add("docs-mode");
  panel.style.top = "auto";
  panel.style.right = "auto";
  panel.style.left = "22px";
  panel.style.bottom = "72px";
}

function createExelidocPanel() {
  const panel = document.createElement("div");
  panel.className = "exelidoc-panel docs-mode";
  panel.id = "exelidoc-docs-panel";
  panel.innerHTML = `
    <div class="exelidoc-panel-header"><span>Exelidoc</span><button class="exelidoc-close" type="button" aria-label="Close Exelidoc panel">&times;</button></div>
    <textarea class="exelidoc-query" placeholder="e.g. write a section, rewrite this, make it more concise"></textarea>
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
    console.info("Exelidoc Docs: Ask clicked", { editorDetected: Boolean(activeBox) });
    if (!activeBox) {
      console.warn("Exelidoc Docs: request stopped; no editable document detected");
      statusEl.textContent = "Click in the document to connect Exelidoc.";
      return;
    }
    const instruction = queryEl.value.trim();
    const text = (activeBox.innerText || "").trim();
    if (!instruction) {
      console.warn("Exelidoc Docs: request stopped; instruction is empty");
      statusEl.textContent = "Enter an instruction before clicking Ask.";
      return;
    }

    statusEl.textContent = "Thinking...";
    submitEl.disabled = true;
    console.info("Exelidoc Docs: sending analysis request", {
      textLength: text.length,
      instructionLength: instruction.length,
    });

    chrome.runtime.sendMessage(
      { type: "ANALYZE_TEXT", text, instruction, historyIds: history.selectedIds() },
      (response) => {
        submitEl.disabled = false;
        if (chrome.runtime.lastError) {
          console.error("Exelidoc Docs: service worker message failed", chrome.runtime.lastError.message);
          statusEl.textContent = "Extension reloaded — refresh this page.";
          return;
        }
        if (!response || !response.ok) {
          console.warn("Exelidoc Docs: analysis request failed", response && response.error);
          statusEl.textContent = response && response.error === "no_session"
            ? "Sign in to Exelidoc from the toolbar popup first."
            : `Error: ${response ? response.error : "no response"}`;
          return;
        }
        if (response.data && response.data.error) {
          console.warn("Exelidoc Docs: backend returned an analysis error", response.data.error);
          statusEl.textContent = `Error: ${response.data.error}`;
          return;
        }
        console.info("Exelidoc Docs: analysis response received");
        history.refresh();
        if (!activeBox) return;

        statusEl.textContent = "";
        const suggestions = Array.isArray(response.data.suggestions) ? response.data.suggestions : [];
        const corrected = response.data.corrected || (suggestions[0] && suggestions[0].revised) || text;

        if (!corrected || corrected === text) {
          statusEl.textContent = "No changes suggested.";
          return;
        }

        preEditSnapshot = captureComposeSnapshot(activeBox);
        if (!setComposeText(activeBox, corrected)) {
          preEditSnapshot = null;
          statusEl.textContent = "Google Docs did not accept the edit. Try clicking in the document and asking again.";
          return;
        }
        undoEl.hidden = false;
        statusEl.textContent = "Updated document.";
      }
    );
  });

  undoEl.addEventListener("click", () => {
    if (activeBox && preEditSnapshot) {
      restoreComposeSnapshot(activeBox, preEditSnapshot);
      preEditSnapshot = null;
      undoEl.hidden = true;
      statusEl.textContent = "Restored previous draft.";
    }
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
  const editor = getDocsEditor();
  if (!editor) return;
  if (editor === boundEditor) return;
  boundEditor = editor;
  setActiveBox(editor);
}

const docsObserver = new MutationObserver(() => {
  initDocsPanel();
});
docsObserver.observe(document.body, { childList: true, subtree: true });

document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".kix-appview-editor")) {
    const editor = getDocsEditor();
    if (editor && editor !== activeBox) setActiveBox(editor);
  }
});

initDocsPanel();
console.info("Exelidoc Docs: content script loaded", {
  version: chrome.runtime.getManifest().version,
});
