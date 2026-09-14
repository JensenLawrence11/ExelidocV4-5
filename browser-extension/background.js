// Service worker: handles anything that shouldn't live in the content script
// (keeps the API key and backend URL out of every content script).

const BACKEND_URL = "http://localhost:5000"; // TODO: swap to prod URL when deployed

// TEMPORARY: single shared key for testing/personal use, so you don't have
// to paste it into the popup every time. Paste your actual key from Supabase
// below in place of the placeholder.
//
// IMPORTANT before giving this to real paying users: this means every
// install shares ONE subscription -- there's no way to tell who's actually
// paid. Swap this back to popup-entered per-user keys (the apiKey ||
// fallback below reverts to that automatically) before public launch.
const DEFAULT_API_KEY = "74e507559890c937bea8b7dbfc54679c383abe0d04c95ae5";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_TEXT") {
    chrome.storage.sync.get(["apiKey"], ({ apiKey }) => {
      const key = apiKey || DEFAULT_API_KEY;
      if (!key || key === "paste-your-key-here") {
        sendResponse({ ok: false, error: "no_api_key" });
        return;
      }

      fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": key,
        },
        body: JSON.stringify({
          text: message.text,
          instruction: message.instruction,
        }),
      })
        .then(async (res) => {
          let data = {};
          const raw = await res.text();
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (e) {
              data = { error: raw };
            }
          }

          if (res.status === 401) return sendResponse({ ok: false, error: "invalid_api_key" });
          if (res.status === 402) return sendResponse({ ok: false, error: "subscription_inactive" });
          if (res.status === 429) return sendResponse({ ok: false, error: data.error || "monthly_limit_reached" });
          if (!res.ok) return sendResponse({ ok: false, error: data.error || "request_failed" });

          sendResponse({ ok: true, data });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
    });

    return true; // keep the message channel open for the async response
  }
});