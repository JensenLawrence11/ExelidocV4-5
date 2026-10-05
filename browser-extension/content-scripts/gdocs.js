let activePanel = null;
let activeBox = null;
let preEditSnapshot = null;
let docsLauncher = null;
let boundEditor = null;

function getDocsEditor() {
  return document.querySelector('.kix-appview-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]');
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
  box.innerHTML = "";
  box.textContent = value || "";

  if (typeof InputEvent !== "undefined") {
    box.dispatchEvent(new InputEvent("input", { bubbles: true, data: value || "" }));
  }
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

function restoreComposeSnapshot(box, snapshot) {
  if (!box || !snapshot) return;

  box.focus();

  if (snapshot.html !== undefined && snapshot.html !== null) {
    box.innerHTML = snapshot.html;
  } else {
    box.textContent = snapshot.text || "";
  }

  if (typeof InputEvent !== "undefined") {
    box.dispatchEvent(new InputEvent("input", { bubbles: true, data: snapshot.text || "" }));
  }
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

function ensureDocsLauncher() {
  if (docsLauncher) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "exelidoc-docs-launcher";
  button.textContent = "Exelidoc";
  button.setAttribute("aria-label", "Open Exelidoc panel");
  button.addEventListener("click", () => {
    openDocsPanel();
  });

  document.body.appendChild(button);
  docsLauncher = button;
}

function openDocsPanel() {
  const editor = getDocsEditor();
  if (editor && editor !== activeBox) setActiveBox(editor);
  if (!activePanel) activePanel = createExelidocPanel();
  activePanel.style.display = "flex";
}

function setActiveBox(box) {
  const sameBox = activeBox === box;
  activeBox = box;

  if (!box) {
    preEditSnapshot = null;
    if (activePanel) activePanel.style.display = "none";
    return;
  }

  if (!sameBox) {
    preEditSnapshot = null;
  }

  if (!activePanel) activePanel = createExelidocPanel();
  resetPanelState(activePanel);
  activePanel.style.display = "flex";
  positionPanel(activePanel, box);
}

function positionPanel(panel, box) {
  if (!panel) return;
  panel.classList.add("docs-mode");
  panel.style.top = "72px";
  panel.style.right = "22px";
  panel.style.left = "auto";
}

function createExelidocPanel() {
  const panel = document.createElement("div");
  panel.className = "exelidoc-panel docs-mode";
  panel.innerHTML = `
    <div class="exelidoc-panel-header">Exelidoc</div>
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
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { selectedIds: () => [], refresh: () => {} };
  if (!window.ExelidocHistory) {
    panel.querySelector(".exelidoc-history-status").textContent = "History helper not loaded. Reload Exelidoc from its updated extension folder.";
  }

  let dragState = null;
  panelHeader.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, textarea")) return;
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: parseFloat(panel.style.left || "0") || 0,
      top: parseFloat(panel.style.top || "0") || 0,
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
    if (!activeBox) return;
    const instruction = queryEl.value.trim();
    const text = (activeBox.innerText || "").trim();
    if (!instruction) return;

    statusEl.textContent = "Thinking...";
    submitEl.disabled = true;

    chrome.runtime.sendMessage(
      { type: "ANALYZE_TEXT", text, instruction, historyIds: history.selectedIds() },
      (response) => {
        submitEl.disabled = false;
        if (chrome.runtime.lastError) {
          statusEl.textContent = "Extension reloaded — refresh this page.";
          return;
        }
        if (!response || !response.ok) {
          statusEl.textContent = response && response.error === "no_session"
            ? "Sign in to Exelidoc from the toolbar popup first."
            : `Error: ${response ? response.error : "no response"}`;
          return;
        }
        if (response.data && response.data.error) {
          statusEl.textContent = `Error: ${response.data.error}`;
          return;
        }
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
        setComposeText(activeBox, corrected);
        undoEl.hidden = false;
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
  if (!editor || editor === boundEditor) return;
  boundEditor = editor;
  editor.addEventListener("focus", () => setActiveBox(editor));
  setActiveBox(editor);
}

const docsObserver = new MutationObserver(() => {
  initDocsPanel();
});
docsObserver.observe(document.body, { childList: true, subtree: true });

document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".kix-appview-editor")) {
    openDocsPanel();
  }
});

initDocsPanel();
