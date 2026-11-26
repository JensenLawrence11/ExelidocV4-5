let activePanel = null;
let activeBox = null;
let preEditSnapshot = null;
let pendingPreview = null;
let gmailSourcePicker = null;

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

  box.dispatchEvent(new InputEvent("input", { bubbles: true, data: value || "" }));
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

  box.dispatchEvent(new InputEvent("input", { bubbles: true, data: snapshot.text || "" }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

function findComposeBoxes() {
  return document.querySelectorAll('div[contenteditable="true"][role="textbox"]');
}

function attachToComposeBox(box) {
  if (box.dataset.exelidocAttached) return;
  box.dataset.exelidocAttached = "true";

  box.addEventListener("focus", () => setActiveBox(box));

  // if this box gets removed from the DOM (draft closed/sent), and it was
  // the active one, tear the panel down
  const removalObserver = new MutationObserver(() => {
    if (!document.body.contains(box)) {
      removalObserver.disconnect();
      if (activeBox === box) setActiveBox(null);
    }
  });
  removalObserver.observe(document.body, { childList: true, subtree: true });
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
    pendingPreview = null;
  }

  if (!activePanel) activePanel = createExelidocPanel();
  resetPanelState(activePanel);
  activePanel.style.display = "flex";
  positionPanel(activePanel, box);
}

function positionPanel(panel, box) {
  const rect = box.getBoundingClientRect();
  const panelWidth = 280; // keep in sync with CSS width
  panel.style.top = `${window.scrollY + rect.top}px`;
  panel.style.left = `${window.scrollX + rect.left - panelWidth - 12}px`;
}

function createExelidocPanel() {
  const panel = document.createElement("div");
  panel.className = "exelidoc-panel";
  panel.innerHTML = `
    <div class="exelidoc-panel-header">Exelidoc</div>
    <textarea class="exelidoc-query" placeholder="e.g. make this more formal, fix grammar, shorten it... or write a new email from scratch"></textarea>
    <div class="exelidoc-gmail-source-picker-slot"></div>
    <button class="exelidoc-submit">Ask</button>
    <section class="exelidoc-docs-preview" hidden>
      <label>Proposed email draft</label>
      <textarea class="exelidoc-docs-preview-text" readonly></textarea>
      <div class="exelidoc-docs-preview-actions">
        <button class="exelidoc-docs-apply" type="button">Apply to draft</button>
        <button class="exelidoc-docs-discard" type="button">Discard</button>
      </div>
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
  const undoEl = panel.querySelector(".exelidoc-undo");
  const statusEl = panel.querySelector(".exelidoc-status");
  const previewEl = panel.querySelector(".exelidoc-docs-preview");
  const previewTextEl = panel.querySelector(".exelidoc-docs-preview-text");
  const applyEl = panel.querySelector(".exelidoc-docs-apply");
  const discardEl = panel.querySelector(".exelidoc-docs-discard");
  const panelHeader = panel.querySelector(".exelidoc-panel-header");
  gmailSourcePicker = window.ExelidocGmailSourcePicker.mount(
    panel.querySelector(".exelidoc-gmail-source-picker-slot")
  );
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { refresh: () => {} };
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
    const requestedBox = activeBox;
    const originalSnapshot = captureComposeSnapshot(requestedBox);

    statusEl.textContent = "Thinking...";
    submitEl.disabled = true;
    pendingPreview = null;
    previewEl.hidden = true;

    chrome.runtime.sendMessage(
      {
        type: "ANALYZE_TEXT",
        text,
        instruction,
        gmailSourceRefs: gmailSourcePicker.getSelectedRefs(),
      },
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
        if (activeBox !== requestedBox || !document.body.contains(requestedBox)) return;

        const corrected = response.data.corrected;

        if (!corrected || corrected === text) {
          statusEl.textContent = "No changes suggested.";
          return;
        }

        pendingPreview = {
          box: requestedBox,
          originalSnapshot,
          correctedText: corrected,
        };
        previewTextEl.value = corrected;
        previewEl.hidden = false;
        const selectedTitles = gmailSourcePicker.getSelectedTitles();
        statusEl.textContent = selectedTitles.length
          ? `Review the proposed draft. Included Gmail: ${selectedTitles.join("; ")}. Your email has not been changed.`
          : "Review the proposed draft. Your email has not been changed.";
      }
    );
  });

  applyEl.addEventListener("click", () => {
    if (!pendingPreview || activeBox !== pendingPreview.box || !document.body.contains(pendingPreview.box)) {
      statusEl.textContent = "The compose window changed. Generate a new preview before applying.";
      return;
    }

    const currentText = pendingPreview.box.textContent || pendingPreview.box.innerText || "";
    if (currentText !== pendingPreview.originalSnapshot.text) {
      statusEl.textContent = "The draft changed after the preview. Generate a new preview before applying.";
      pendingPreview = null;
      previewEl.hidden = true;
      return;
    }

    preEditSnapshot = pendingPreview.originalSnapshot;
    setComposeText(pendingPreview.box, pendingPreview.correctedText);
    pendingPreview = null;
    previewEl.hidden = true;
    undoEl.hidden = false;
    statusEl.textContent = "Draft updated. It has not been sent.";
  });

  discardEl.addEventListener("click", () => {
    pendingPreview = null;
    previewTextEl.value = "";
    previewEl.hidden = true;
    statusEl.textContent = "Preview discarded. Your draft was not changed.";
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
  gmailSourcePicker?.clear();
  panel.querySelector(".exelidoc-status").textContent = "";
  panel.querySelector(".exelidoc-undo").hidden = true;
  panel.querySelector(".exelidoc-docs-preview").hidden = true;
  panel.querySelector(".exelidoc-docs-preview-text").value = "";
  pendingPreview = null;
  panel.dataset.userMoved = "false";
}

const observer = new MutationObserver(() => {
  findComposeBoxes().forEach(attachToComposeBox);

  if (activeBox && activePanel && document.body.contains(activeBox) && activePanel.dataset.userMoved !== "true") {
    positionPanel(activePanel, activeBox);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

document.addEventListener("focusin", (event) => {
  if (!activeBox) return;

  const target = event.target;
  const withinBox = activeBox.contains(target);
  const withinPanel = activePanel && activePanel.contains(target);

  if (!withinBox && !withinPanel) {
    setActiveBox(null);
  }
});