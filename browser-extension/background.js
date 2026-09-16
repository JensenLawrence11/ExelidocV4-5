// Service worker: remembers the signed-in user with a session token, not a raw API key.

const BACKEND_URL = "https://exelidocv4-5.onrender.com";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_TEXT") {
    chrome.storage.sync.get(["sessionToken"], ({ sessionToken }) => {
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