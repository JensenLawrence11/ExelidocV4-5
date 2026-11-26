let slidesPanel = null;
let slidesLauncher = null;

function getCurrentPresentationId() {
  return window.location.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] || null;
}

function ensureSlidesLauncher() {
  if (slidesLauncher) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "exelidoc-docs-launcher";
  button.textContent = "Exelidoc";
  button.setAttribute("aria-label", "Open Exelidoc Slides panel");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    const open = slidesPanel && window.getComputedStyle(slidesPanel).display !== "none";
    if (open) {
      slidesPanel.style.display = "none";
      button.setAttribute("aria-expanded", "false");
      return;
    }
    if (!slidesPanel) slidesPanel = createSlidesPanel();
    slidesPanel.style.display = "flex";
    button.setAttribute("aria-expanded", "true");
  });
  document.body.appendChild(button);
  slidesLauncher = button;
}

function createSlidesPanel() {
  const panel = document.createElement("section");
  panel.className = "exelidoc-panel docs-mode";
  panel.innerHTML = `
    <div class="exelidoc-panel-header"><span>Exelidoc · Slides</span><button class="exelidoc-close" type="button" aria-label="Close Exelidoc panel">&times;</button></div>
    <textarea class="exelidoc-query" maxlength="10000" placeholder="Ask a question about this presentation"></textarea>
    <div class="exelidoc-docs-note">Slide text is read only after you ask. History keeps your question and a safe source reference, not slide text or the answer.</div>
    <button class="exelidoc-submit" type="button">Ask about slides</button>
    <pre class="exelidoc-slides-answer" aria-live="polite"></pre>
    <details class="exelidoc-history">
      <summary>History</summary>
      <div class="exelidoc-history-content">
        <div class="exelidoc-history-status" role="status" aria-live="polite"></div>
        <div class="exelidoc-history-list"></div>
        <button class="exelidoc-history-more" type="button" hidden>Load older</button>
      </div>
    </details>
  `;
  const query = panel.querySelector(".exelidoc-query");
  const submit = panel.querySelector(".exelidoc-submit");
  const answer = panel.querySelector(".exelidoc-slides-answer");
  const history = window.ExelidocHistory
    ? window.ExelidocHistory.mount(panel)
    : { refresh() {} };
  panel.querySelector(".exelidoc-close").addEventListener("click", () => {
    panel.style.display = "none";
    slidesLauncher?.setAttribute("aria-expanded", "false");
  });
  submit.addEventListener("click", () => {
    const presentationId = getCurrentPresentationId();
    const prompt = query.value.trim();
    if (!presentationId) {
      answer.textContent = "Open a Google Slides presentation and try again.";
      return;
    }
    if (!prompt) {
      answer.textContent = "Enter a question first.";
      return;
    }
    submit.disabled = true;
    answer.textContent = "Reading the presentation and asking Gemini...";
    chrome.runtime.sendMessage(
      { type: "ANALYZE_GOOGLE_SLIDES", presentationId, prompt },
      (response) => {
        submit.disabled = false;
        if (chrome.runtime.lastError) {
          answer.textContent = "Extension reloaded — refresh this page.";
          return;
        }
        if (!response?.ok) {
          answer.textContent = response?.error === "no_session"
            ? "Sign in to Exelidoc from the toolbar popup first."
            : `Error: ${response?.error || "No response from Exelidoc."}`;
          return;
        }
        answer.textContent = response.answer;
        history.refresh();
      }
    );
  });
  document.body.appendChild(panel);
  return panel;
}

function initSlidesPanel() {
  ensureSlidesLauncher();
}

initSlidesPanel();
