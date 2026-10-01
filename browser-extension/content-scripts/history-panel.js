(() => {
  const PAGE_SIZE = 30;
  const MAX_MENTIONED_ITEMS = 5;

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

  function responseText(response) {
    if (response && typeof response.generated === "string") return response.generated;
    if (response && typeof response.corrected === "string") return response.corrected;
    return JSON.stringify(response, null, 2);
  }

  function mount(panel) {
    const drawer = document.createElement("details");
    drawer.className = "exelidoc-history";
    drawer.innerHTML = `
      <summary>History</summary>
      <div class="exelidoc-history-content">
        <div class="exelidoc-history-status" role="status" aria-live="polite"></div>
        <div class="exelidoc-history-list"></div>
        <button class="exelidoc-history-more" type="button" hidden>Load older</button>
      </div>
    `;
    panel.appendChild(drawer);

    const status = drawer.querySelector(".exelidoc-history-status");
    const list = drawer.querySelector(".exelidoc-history-list");
    const moreButton = drawer.querySelector(".exelidoc-history-more");
    let offset = 0;
    let loaded = false;
    let loading = false;

    function render(items, append) {
      const selectedIds = new Set(
        Array.from(drawer.querySelectorAll(".exelidoc-history-mention input:checked"))
          .map((checkbox) => checkbox.value)
      );
      if (!append) list.replaceChildren();
      if (!items.length && !append) {
        list.textContent = "No saved requests yet.";
        return;
      }

      items.forEach((item) => {
        const row = document.createElement("article");
        row.className = "exelidoc-history-item";
        row.dataset.historyId = item.id;

        const mention = document.createElement("label");
        mention.className = "exelidoc-history-mention";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = item.id;
        checkbox.checked = selectedIds.has(item.id);
        checkbox.addEventListener("change", () => {
          const selected = drawer.querySelectorAll(".exelidoc-history-mention input:checked");
          if (selected.length > MAX_MENTIONED_ITEMS) {
            checkbox.checked = false;
            status.textContent = `Choose up to ${MAX_MENTIONED_ITEMS} history items.`;
          } else {
            status.textContent = "";
          }
        });
        const mentionText = document.createElement("span");
        mentionText.textContent = "Mention in chat";
        mention.append(checkbox, mentionText);

        const prompt = document.createElement("div");
        prompt.className = "exelidoc-history-prompt";
        prompt.textContent = item.prompt || item.action;

        const metadata = document.createElement("div");
        metadata.className = "exelidoc-history-meta";
        metadata.textContent = `${item.client} · ${new Date(item.created_at).toLocaleString()}`;

        const exchange = document.createElement("details");
        exchange.className = "exelidoc-history-exchange";
        const exchangeSummary = document.createElement("summary");
        exchangeSummary.textContent = "View reply";
        const reply = document.createElement("pre");
        reply.textContent = responseText(item.response);
        exchange.append(exchangeSummary, reply);

        row.append(mention, prompt, metadata, exchange);
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

    return {
      selectedIds() {
        return Array.from(drawer.querySelectorAll(".exelidoc-history-mention input:checked"))
          .map((checkbox) => checkbox.value);
      },
      refresh() {
        if (drawer.open) load();
      },
    };
  }

  window.ExelidocHistory = { mount };
})();
