(() => {
  const PAGE_SIZE = 30;

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: "Extension reloaded. Refresh this page." });
          return;
        }
        resolve(response || { ok: false, error: "No response from Exelidoc." });
      });
    });
  }

  function mount(panel) {
    const drawer = panel.querySelector(".exelidoc-history");

    const status = drawer.querySelector(".exelidoc-history-status");
    const list = drawer.querySelector(".exelidoc-history-list");
    const moreButton = drawer.querySelector(".exelidoc-history-more");
    let offset = 0;
    let loaded = false;
    let loading = false;

    function render(items, append) {
      if (!append) list.replaceChildren();
      const questions = items.filter((item) => typeof item.prompt === "string" && item.prompt.trim());
      if (!questions.length && !append) {
        list.textContent = "No saved questions yet.";
        return;
      }

      questions.forEach((item) => {
        const row = document.createElement("article");
        row.className = "exelidoc-history-item";
        const prompt = document.createElement("p");
        prompt.className = "exelidoc-history-prompt";
        prompt.textContent = item.prompt;
        row.append(prompt);

        if (Array.isArray(item.source_refs) && item.source_refs.length) {
          const form = document.createElement("form");
          const input = document.createElement("textarea");
          input.maxLength = 10000;
          input.required = true;
          input.placeholder = "Ask a follow-up about these sources";
          const submit = document.createElement("button");
          submit.type = "submit";
          submit.textContent = "Ask follow-up";
          const answer = document.createElement("div");
          answer.className = "exelidoc-history-answer";
          form.append(input, submit, answer);
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const question = input.value.trim();
            if (!question) return;
            submit.disabled = true;
            answer.textContent = "Re-reading the selected sources...";
            try {
              const result = await sendMessage({
                type: "FOLLOW_UP_HISTORY",
                prompt: question,
                previousPrompt: item.prompt,
                sourceRefs: item.source_refs,
              });
              if (!result.ok) throw new Error(result.error || "Could not answer the follow-up.");
              answer.textContent = result.answer || "Exelidoc returned no answer.";
            } catch (error) {
              answer.textContent = error.message;
            } finally {
              submit.disabled = false;
            }
          });
          row.append(form);
        }
        list.appendChild(row);
      });
    }

    async function load(append = false) {
      if (loading) return;
      loading = true;
      if (!append) {
        offset = 0;
        status.textContent = "Loading history...";
      }
      const response = await sendMessage({ type: "GET_HISTORY", limit: PAGE_SIZE, offset });
      loading = false;
      if (!response.ok) {
        status.textContent = response.error || "Could not load history.";
        return;
      }
      const items = response.data.history || [];
      render(items, append);
      offset += items.length;
      moreButton.hidden = !response.data.has_more;
      status.textContent = "";
      loaded = true;
    }

    drawer.addEventListener("toggle", () => {
      if (drawer.open && !loaded) load();
    });
    moreButton.addEventListener("click", () => load(true));

    return { refresh() { if (drawer.open) load(); } };
  }

  window.ExelidocHistory = { mount };
})();
