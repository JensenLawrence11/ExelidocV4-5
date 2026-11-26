(() => {
  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Extension reloaded. Refresh this page."));
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

  function mount(container) {
    const section = document.createElement("details");
    section.className = "exelidoc-gmail-source-picker";
    section.innerHTML = `
      <summary>Use Gmail emails (optional)</summary>
      <label>Find matching emails</label>
      <input type="search" maxlength="200" placeholder="Search subject, sender, or message text" />
      <button class="exelidoc-gmail-search" type="button">Find emails</button>
      <div class="exelidoc-gmail-results"></div>
      <div class="exelidoc-gmail-status" role="status" aria-live="polite"></div>
      <p class="exelidoc-gmail-note">Matching emails are selected automatically. Uncheck any you don't want included. Email content goes to the AI only when you click Ask or Generate preview.</p>
    `;
    const queryInput = section.querySelector('input[type="search"]');
    const searchButton = section.querySelector(".exelidoc-gmail-search");
    const resultsContainer = section.querySelector(".exelidoc-gmail-results");
    const status = section.querySelector(".exelidoc-gmail-status");
    let items = [];

    searchButton.addEventListener("click", async () => {
      const query = queryInput.value.trim();
      if (!query) {
        status.textContent = "Enter a word or phrase to find emails.";
        return;
      }
      searchButton.disabled = true;
      status.textContent = "Searching indexed and recent Gmail messages...";
      resultsContainer.replaceChildren();
      items = [];
      try {
        const response = await sendRuntimeMessage({ type: "SEARCH_GMAIL_CONTEXT", query });
        items = response.items || [];
        if (!items.length) {
          status.textContent = "No matching Gmail messages. Your inbox index refreshes every 5 minutes while Chrome is open.";
          return;
        }
        items.forEach((item, index) => {
          const label = document.createElement("label");
          label.className = "exelidoc-gmail-result";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = String(index);
          checkbox.checked = true;
          const title = document.createElement("span");
          title.textContent = `${item.title || "(no subject)"}${item.from ? ` · ${item.from}` : ""} · ${item.location || "All Mail"}`;
          label.append(checkbox, title);
          resultsContainer.append(label);
        });
        status.textContent = `${items.length} email(s) found. Select up to 4 to use as context.`;
      } catch (error) {
        status.textContent = error.message;
      } finally {
        searchButton.disabled = false;
      }
    });

    container.append(section);
    return {
      getSelectedRefs() {
        return Array.from(resultsContainer.querySelectorAll('input[type="checkbox"]:checked'))
          .slice(0, 4)
          .map((checkbox) => items[Number(checkbox.value)]?.sourceRef)
          .filter(Boolean);
      },
      getSelectedTitles() {
        return Array.from(resultsContainer.querySelectorAll('input[type="checkbox"]:checked'))
          .slice(0, 4)
          .map((checkbox) => items[Number(checkbox.value)]?.title)
          .filter(Boolean);
      },
      clear() {
        items = [];
        queryInput.value = "";
        resultsContainer.replaceChildren();
        status.textContent = "";
      },
    };
  }

  window.ExelidocGmailSourcePicker = { mount };
})();
