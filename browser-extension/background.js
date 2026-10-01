// Service worker: remembers the signed-in user with a session token, not a raw API key.

const BACKEND_URL = "https://exelidocv4-5.onrender.com";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_HISTORY") {
    chrome.storage.local.get(["sessionToken"], ({ sessionToken }) => {
      if (!sessionToken) {
        sendResponse({ ok: false, error: "Sign in from the Exelidoc toolbar popup to view history." });
        return;
      }

      const params = new URLSearchParams({
        limit: String(message.limit || 30),
        offset: String(message.offset || 0),
      });
      fetch(`${BACKEND_URL}/api/history?${params}`, {
        headers: { "X-Session-Token": sessionToken },
      })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            sendResponse({ ok: false, error: data.error || "Could not load history." });
            return;
          }
          sendResponse({ ok: true, data });
        })
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
    });
    return true;
  }

  if (message.type === "ANALYZE_TEXT") {
    chrome.storage.local.get(["sessionToken"], ({ sessionToken }) => {
      if (!sessionToken) {
        sendResponse({ ok: false, error: "no_session" });
        return;
      }

      fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": sessionToken,
        },
        body: JSON.stringify({
          text: message.text,
          instruction: message.instruction,
          history_ids: Array.isArray(message.historyIds) ? message.historyIds : [],
          client: "chrome",
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

          if (res.status === 401) return sendResponse({ ok: false, error: "invalid_session" });
          if (res.status === 402) return sendResponse({ ok: false, error: "subscription_inactive" });
          if (res.status === 429) return sendResponse({ ok: false, error: data.error || "monthly_limit_reached" });
          if (!res.ok) return sendResponse({ ok: false, error: data.error || "request_failed" });

          sendResponse({ ok: true, data });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
    });

    return true;
  }
});