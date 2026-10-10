// Service worker: remembers the signed-in user with a session token, not a raw API key.

const BACKEND_URL = "https://exelidocv4-5.onrender.com";
const GOOGLE_DOCS_API = "https://docs.googleapis.com/v1/documents";

function getDocsDocumentId(message, sender) {
  let senderUrl;
  try {
    senderUrl = new URL(sender.url || "");
  } catch (error) {
    throw new Error("Open Exelidoc from a Google Docs document.");
  }

  const match = senderUrl.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/);
  if (senderUrl.hostname !== "docs.google.com" || !match || match[1] !== message.documentId) {
    throw new Error("The active Google Docs document could not be verified. Refresh the document and try again.");
  }
  return match[1];
}

function getGoogleDocsAccessToken() {
  const oauthClientId = chrome.runtime.getManifest().oauth2?.client_id;
  if (!oauthClientId || oauthClientId.includes("REPLACE_WITH")) {
    return Promise.reject(new Error("Google Docs OAuth is not configured for this extension."));
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error("Google Docs authorization was not completed."));
      } else {
        resolve(token);
      }
    });
  });
}

async function readGoogleApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Google Docs API returned ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

function extractDocsText(content = []) {
  return content.map((item) => {
    if (item.paragraph) {
      return (item.paragraph.elements || [])
        .map((element) => element.textRun?.content || "")
        .join("");
    }
    return "";
  }).join("");
}

function assertPlainTextDocument(content = []) {
  const hasUnsupportedContent = content.some((item) => {
    if (!item.paragraph) return !item.sectionBreak;
    return (item.paragraph.elements || []).some((element) => !element.textRun);
  });
  if (hasUnsupportedContent) {
    throw new Error("This Docs API flow currently supports plain-text documents only; tables and embedded objects were not changed.");
  }
}

async function getGoogleDocument(documentId, accessToken) {
  const response = await fetch(`${GOOGLE_DOCS_API}/${encodeURIComponent(documentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return readGoogleApiResponse(response);
}

async function replaceGoogleDocumentText(document, text, accessToken) {
  const endIndex = (document.body?.content || []).at(-1)?.endIndex;
  if (!Number.isInteger(endIndex)) {
    throw new Error("Google Docs did not return a writable document body.");
  }

  const requests = [];
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  if (text) {
    requests.push({ insertText: { location: { index: 1 }, text } });
  }
  if (!requests.length) return;

  const response = await fetch(`${GOOGLE_DOCS_API}/${encodeURIComponent(document.documentId)}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests,
      writeControl: { requiredRevisionId: document.revisionId },
    }),
  });
  await readGoogleApiResponse(response);
}

async function handleGoogleDocsAnalysis(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) throw new Error("no_session");

  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  const previousText = extractDocsText(document.body?.content || []).replace(/\n+$/, "");
  const originalText = previousText.trim();
  const response = await fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      text: originalText,
      instruction: message.instruction,
      history_ids: Array.isArray(message.historyIds) ? message.historyIds : [],
      client: "chrome-docs-api",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
  }
  if (data.error) throw new Error(data.error);

  const correctedText = typeof data.corrected === "string" ? data.corrected : originalText;
  const changed = correctedText !== originalText;
  if (changed) {
    await replaceGoogleDocumentText(document, correctedText, accessToken);
  }
  return { ok: true, data, changed, previousText };
}

async function restoreGoogleDocumentText(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  await replaceGoogleDocumentText(document, String(message.text || ""), accessToken);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_GOOGLE_DOC") {
    handleGoogleDocsAnalysis(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Docs request failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google Docs request failed." });
      });
    return true;
  }

  if (message.type === "RESTORE_GOOGLE_DOC") {
    restoreGoogleDocumentText(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "Google Docs restore failed." }));
    return true;
  }

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
    console.info("Exelidoc background: analysis message received");
    chrome.storage.local.get(["sessionToken"], ({ sessionToken }) => {
      if (!sessionToken) {
        console.warn("Exelidoc background: request stopped; no saved session");
        sendResponse({ ok: false, error: "no_session" });
        return;
      }

      console.info("Exelidoc background: posting analysis request");
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
          console.info("Exelidoc background: backend responded", { status: res.status });
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
        .catch((err) => {
          console.error("Exelidoc background: backend request failed", String(err));
          sendResponse({ ok: false, error: String(err) });
        });
    });

    return true;
  }
});