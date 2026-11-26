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
      if (!items.length && !append) {
        list.textContent = "No saved requests yet.";
        return;
      }

      items.forEach((item) => {
        const row = document.createElement("article");
        row.className = "exelidoc-history-item";
        const metadata = document.createElement("div");
        metadata.className = "exelidoc-history-meta";
        metadata.textContent = `${item.action} · ${item.client} · ${new Date(item.created_at).toLocaleString()}`;

        row.append(metadata);

        const sourceUrls = Array.isArray(item.source_urls) && item.source_urls.length
          ? item.source_urls
          : [item.source_url];
        sourceUrls.forEach((sourceUrl, index) => {
          if (typeof sourceUrl !== "string") return;
          try {
            const source = new URL(sourceUrl);
            if (source.protocol === "https:") {
              const link = document.createElement("a");
              link.href = source.href;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              link.textContent = sourceUrls.length > 1 ? `Open source ${index + 1}` : "Open source";
              row.append(link);
            }
          } catch (error) {
            console.warn("Exelidoc history: invalid source link", error);
          }
        });
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
