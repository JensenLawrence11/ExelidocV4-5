// Service worker: remembers the signed-in user with a session token, not a raw API key.

const BACKEND_URL = "https://exelidocv4-5.onrender.com";
const GOOGLE_DOCS_API = "https://docs.googleapis.com/v1/documents";
const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const GOOGLE_SHEETS_EDIT_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_DATA_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];
const GOOGLE_CONNECT_SCOPES = [
  ...GOOGLE_DATA_SCOPES,
  GOOGLE_SHEETS_EDIT_SCOPE,
  GOOGLE_DOCS_SCOPE,
];
const GOOGLE_ACCESS_CONFIG_VERSION = 2;
const GOOGLE_SOURCE_LIMIT = 4;
const GOOGLE_SOURCE_CONTENT_LIMIT = 6000;
const GOOGLE_SHEET_EDIT_MAX_CELLS = 2500;
const GMAIL_INDEX_BODY_LIMIT = 20000;
const GMAIL_INDEX_PAGE_SIZE = 100;
const GMAIL_SCAN_ALARM = "exelidoc-gmail-inbox-scan";
const GMAIL_INDEX_DB_NAME = "exelidoc-gmail-index";
const GMAIL_INDEX_DB_VERSION = 1;
let gmailScanPromise = null;
let gmailScanCancelled = false;

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

function getGoogleSourceUrl(sender) {
  try {
    const url = new URL(sender.url || "");
    if (
      url.protocol !== "https:"
      || !["docs.google.com", "mail.google.com", "sheets.google.com", "drive.google.com"].includes(url.hostname)
    ) {
      return null;
    }
    return `${url.origin}${url.pathname}`;
  } catch (error) {
    return null;
  }
}

function getGmailSourceRef(sender) {
  try {
    const url = new URL(sender.url || "");
    if (url.hostname !== "mail.google.com") return null;
    const identifier = url.hash.slice(1).split(/[/?]/).filter(Boolean).pop();
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(identifier || "")) return null;
    return { provider: "google", kind: "gmail_message", id: identifier };
  } catch (error) {
    return null;
  }
}

function getGoogleAccessToken(scopes, interactive) {
  const oauthClientId = chrome.runtime.getManifest().oauth2?.client_id;
  if (!oauthClientId || oauthClientId.includes("REPLACE_WITH")) {
    return Promise.reject(new Error("Google OAuth is not configured for this extension."));
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive, scopes }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error("Google authorization was not completed."));
      } else {
        resolve(token);
      }
    });
  });
}

function getGoogleDocsAccessToken() {
  return getGoogleAccessToken(
    [GOOGLE_DOCS_SCOPE],
    false
  );
}

async function readGoogleApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Google API returned ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function googleAuthorizationHelp(error, service) {
  const message = error?.message || `${service} request failed.`;
  if (
    error?.status === 403
    || /oauth|insufficient authentication|not authorized|permission denied|access not configured|scope/i.test(message)
  ) {
    if (service === "Google data") {
      return `Google OAuth authorization failed. Check that the signed-in account has access to the requested Google data. Google reported: ${message}`;
    }
    return `Google denied ${service} access. Check that the ${service} API is enabled and the signed-in account can access this file. Google reported: ${message}`;
  }
  return message;
}

function extractDocsText(content = []) {
  return content.map((item) => {
    if (item.paragraph) {
      return (item.paragraph.elements || [])
        .map((element) => element.textRun?.content || "")
        .join("");
    }
    if (item.table) {
      return (item.table.tableRows || [])
        .map((row) => (row.tableCells || [])
          .map((cell) => extractDocsText(cell.content || []))
          .join("\t"))
        .join("\n");
    }
    if (item.tableOfContents) {
      return extractDocsText(item.tableOfContents.content || []);
    }
    return "";
  }).join("");
}

function getDocumentPlainText(document) {
  const text = extractDocsText(document.body?.content || []);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

async function googleApiRequest(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return readGoogleApiResponse(response);
}

function decodeBase64Url(value) {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function stripHtml(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getHeader(headers, name) {
  return (headers || []).find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function getGmailBody(payload, limit = GOOGLE_SOURCE_CONTENT_LIMIT) {
  const plainParts = [];
  const htmlParts = [];
  function collect(part) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      plainParts.push(decodeBase64Url(part.body.data));
      return;
    }
    (part.parts || []).forEach(collect);
    if (!part.parts?.length && part.mimeType === "text/html" && part.body?.data) {
      htmlParts.push(stripHtml(decodeBase64Url(part.body.data)));
    }
  }
  collect(payload || {});
  return (plainParts.length ? plainParts : htmlParts)
    .join("\n")
    .trim()
    .slice(0, limit);
}

function openGmailIndex() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GMAIL_INDEX_DB_NAME, GMAIL_INDEX_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("messages")) {
        database.createObjectStore("messages", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local Gmail index."));
  });
}

async function writeGmailIndexMessages(messages) {
  if (!messages.length) return;
  const database = await openGmailIndex();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      messages.forEach((message) => store.put(message));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not update the local Gmail index."));
      transaction.onabort = () => reject(transaction.error || new Error("The local Gmail index update was aborted."));
    });
  } finally {
    database.close();
  }
}

async function deleteGmailIndexMessages(ids) {
  if (!ids.length) return;
  const database = await openGmailIndex();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      ids.forEach((id) => store.delete(id));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not remove messages from the local Gmail index."));
      transaction.onabort = () => reject(transaction.error || new Error("The local Gmail index update was aborted."));
    });
  } finally {
    database.close();
  }
}

async function readGmailIndexMessages() {
  const database = await openGmailIndex();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("messages", "readonly");
      const request = transaction.objectStore("messages").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Could not read the local Gmail index."));
    });
  } finally {
    database.close();
  }
}

async function clearGmailIndex() {
  if (typeof indexedDB === "undefined") return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(GMAIL_INDEX_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error || new Error("Could not clear the local Gmail index."));
    request.onblocked = () => reject(new Error("Close other Exelidoc extension pages before clearing the Gmail index."));
  });
}

function getGmailMessageUrl(messageId) {
  return `https://mail.google.com/mail/#all/${encodeURIComponent(messageId)}`;
}

async function getGmailMessage(messageId, accessToken, bodyLimit = GOOGLE_SOURCE_CONTENT_LIMIT) {
  const message = await googleApiRequest(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    accessToken
  );
  const headers = message.payload?.headers || [];
  return {
    id: message.id,
    threadId: message.threadId,
    subject: getHeader(headers, "subject") || "(no subject)",
    from: getHeader(headers, "from"),
    date: getHeader(headers, "date"),
    internalDate: Number(message.internalDate) || 0,
    snippet: message.snippet || "",
    body: getGmailBody(message.payload, bodyLimit),
    labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
  };
}

function driveQueryForTerms(query) {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const uniqueTerms = Array.from(new Set(terms)).slice(0, 5);
  if (!uniqueTerms.length) {
    throw new Error("Use at least one word with two or more letters or numbers to search Drive.");
  }
  const conditions = uniqueTerms.map((term) => {
    const escaped = term.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `(fullText contains '${escaped}' or name contains '${escaped}')`;
  });
  return `trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.presentation') and (${conditions.join(" or ")})`;
}

async function getGmailSearchResults(query, accessToken) {
  const params = new URLSearchParams({ q: query, maxResults: String(GOOGLE_SOURCE_LIMIT) });
  const list = await googleApiRequest(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    accessToken
  );
  const messages = await Promise.all((list.messages || []).map(async (item) => {
    const message = await getGmailMessage(item.id, accessToken);
    return makeGmailSource(message);
  }));
  return messages;
}

function makeGmailSource(message) {
  const labelOrder = [
    ["INBOX", "Inbox"],
    ["SENT", "Sent"],
    ["DRAFT", "Drafts"],
    ["TRASH", "Trash"],
    ["SPAM", "Spam"],
    ["STARRED", "Starred"],
    ["IMPORTANT", "Important"],
    ["CATEGORY_PERSONAL", "Primary"],
    ["CATEGORY_SOCIAL", "Social"],
    ["CATEGORY_PROMOTIONS", "Promotions"],
    ["CATEGORY_UPDATES", "Updates"],
    ["CATEGORY_FORUMS", "Forums"],
  ];
  const labels = new Set(message.labelIds || []);
  const location = labelOrder.find(([id]) => labels.has(id))?.[1] || "All Mail";
  return {
    type: "email",
    title: message.subject,
    url: getGmailMessageUrl(message.id),
    from: message.from,
    date: message.date,
    location,
    content: [
      `From: ${message.from}`,
      `Date: ${message.date}`,
      `Subject: ${message.subject}`,
      "",
      message.body || message.snippet,
    ].filter(Boolean).join("\n").slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
    sourceRef: { provider: "google", kind: "gmail_message", id: message.id },
  };
}

function getGmailSearchTerms(query) {
  return (query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
    .slice(0, 8);
}

async function searchGmailLocalIndex(query) {
  const terms = getGmailSearchTerms(query);
  if (!terms.length) return [];
  const messages = await readGmailIndexMessages();
  return messages
    .filter((message) => {
      const searchable = `${message.subject}\n${message.from}\n${message.snippet}\n${message.body}`.toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .sort((left, right) => right.internalDate - left.internalDate)
    .slice(0, GOOGLE_SOURCE_LIMIT)
    .map(makeGmailSource);
}

async function getGmailProfile(accessToken) {
  return googleApiRequest(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    accessToken
  );
}

function getGmailIndexRecord(message) {
  return {
    ...message,
    body: message.body.slice(0, GMAIL_INDEX_BODY_LIMIT),
    indexedAt: Date.now(),
    url: getGmailMessageUrl(message.id),
  };
}

async function getGmailScanState() {
  const { gmailScanState } = await chrome.storage.local.get("gmailScanState");
  return gmailScanState || {
    status: "not_started",
    indexedCount: 0,
    lastScanAt: null,
    lastError: null,
    initialScanStarted: false,
    initialHistoryId: null,
    nextPageToken: null,
    historyId: null,
  };
}

async function setGmailScanState(state) {
  await chrome.storage.local.set({ gmailScanState: state });
  return state;
}

function createGmailScanAlarm(delayInMinutes, periodInMinutes = 5) {
  chrome.alarms.create(GMAIL_SCAN_ALARM, { delayInMinutes, periodInMinutes });
}

async function ensureGmailIndexScanScheduled() {
  const { googleDataConnected } = await chrome.storage.local.get("googleDataConnected");
  if (!googleDataConnected) return;
  const alarm = await chrome.alarms.get(GMAIL_SCAN_ALARM);
  if (!alarm || alarm.periodInMinutes !== 5) createGmailScanAlarm(0.5);
}

async function ensureGmailConnected() {
  const { googleDataConnected } = await chrome.storage.local.get("googleDataConnected");
  if (!googleDataConnected) {
    throw new Error("Connect Google access to scan the inbox.");
  }
}

async function fetchGmailIndexPage(pageToken, accessToken) {
  const params = new URLSearchParams({
    q: "in:inbox",
    maxResults: String(GMAIL_INDEX_PAGE_SIZE),
  });
  if (pageToken) params.set("pageToken", pageToken);
  return googleApiRequest(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    accessToken
  );
}

async function fetchGmailIndexBatch(messageIds, accessToken) {
  const records = [];
  for (let start = 0; start < messageIds.length; start += 5) {
    if (gmailScanCancelled) return records;
    const batch = messageIds.slice(start, start + 5);
    const messages = await Promise.all(batch.map(async (id) => {
      try {
        return await getGmailMessage(id, accessToken, GMAIL_INDEX_BODY_LIMIT);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    }));
    records.push(...messages.filter((message) => message && message.labelIds.includes("INBOX")));
  }
  return records;
}

async function syncGmailHistory(startHistoryId, accessToken) {
  let pageToken = null;
  let newestHistoryId = startHistoryId;
  const changedMessageIds = new Set();
  const deletedMessageIds = new Set();
  do {
    const params = new URLSearchParams({ startHistoryId });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleApiRequest(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?${params}`,
      accessToken
    );
    newestHistoryId = data.historyId || newestHistoryId;
    (data.history || []).forEach((item) => {
      const added = item.messagesAdded || [];
      const labelsAdded = item.labelsAdded || [];
      const labelsRemoved = item.labelsRemoved || [];
      added.concat(labelsAdded, labelsRemoved).forEach(({ message }) => {
        if (message?.id) changedMessageIds.add(message.id);
      });
      (item.messagesDeleted || []).forEach(({ message }) => {
        if (message?.id) deletedMessageIds.add(message.id);
      });
    });
    pageToken = data.nextPageToken || null;
  } while (pageToken && !gmailScanCancelled);

  if (gmailScanCancelled) return newestHistoryId;
  const updateIds = Array.from(changedMessageIds)
    .filter((id) => !deletedMessageIds.has(id));
  const updatedMessages = await fetchGmailIndexBatch(updateIds, accessToken);
  await deleteGmailIndexMessages(Array.from(deletedMessageIds));
  await deleteGmailIndexMessages(
    updateIds.filter((id) => !updatedMessages.some((message) => message.id === id))
  );
  await writeGmailIndexMessages(updatedMessages.map(getGmailIndexRecord));
  return newestHistoryId;
}

async function getGmailIndexSearchResults(query) {
  try {
    return await searchGmailLocalIndex(query);
  } catch (error) {
    console.warn("Exelidoc Gmail: local index search failed; using Gmail search", error.message);
    return [];
  }
}

function validateGmailSourceRefs(sourceRefs) {
  if (sourceRefs === undefined) return [];
  if (!Array.isArray(sourceRefs) || sourceRefs.length > GOOGLE_SOURCE_LIMIT) {
    throw new Error(`Select no more than ${GOOGLE_SOURCE_LIMIT} Gmail messages.`);
  }
  const uniqueRefs = new Map();
  sourceRefs.forEach((sourceRef) => {
    if (
      sourceRef?.provider !== "google"
      || sourceRef.kind !== "gmail_message"
      || !/^[A-Za-z0-9_-]{1,256}$/.test(sourceRef.id || "")
    ) {
      throw new Error("A selected Gmail message could not be verified.");
    }
    uniqueRefs.set(sourceRef.id, {
      provider: "google",
      kind: "gmail_message",
      id: sourceRef.id,
    });
  });
  return Array.from(uniqueRefs.values());
}

async function getSelectedGmailContext(sourceRefs) {
  const refs = validateGmailSourceRefs(sourceRefs);
  if (!refs.length) return { context: "", sourceRefs: [], sources: [] };
  const accessToken = await getGoogleAccessToken(
    ["https://www.googleapis.com/auth/gmail.readonly"],
    false
  );
  const sources = await Promise.all(refs.map((sourceRef) => (
    getGoogleSourceForRef(sourceRef, accessToken)
  )));
  const context = sources.map((source) => (
    `Email: ${source.title}\nURL: ${source.url}\n${source.content}`
  )).join("\n\n---\n\n").slice(0, 18000);
  return { context, sourceRefs: refs, sources };
}

async function searchGmailContext(query) {
  if (typeof query !== "string" || !query.trim() || query.length > 200) {
    throw new Error("Enter a Gmail search with 1 to 200 characters.");
  }
  const accessToken = await getGoogleAccessToken(
    ["https://www.googleapis.com/auth/gmail.readonly"],
    false
  );
  const [indexedEmails, searchedEmails] = await Promise.all([
    getGmailIndexSearchResults(query.trim()),
    getGmailSearchResults(query.trim(), accessToken),
  ]);
  const seenMessageIds = new Set();
  return [...indexedEmails, ...searchedEmails]
    .filter((source) => {
      const id = source.sourceRef?.id;
      if (id && seenMessageIds.has(id)) return false;
      if (id) seenMessageIds.add(id);
      return true;
    })
    .slice(0, GOOGLE_SOURCE_LIMIT);
}

async function fullGmailInboxScan(accessToken, state) {
  if (!state.initialScanStarted) {
    const profile = await getGmailProfile(accessToken);
    state = {
      ...state,
      status: "scanning",
      initialScanStarted: true,
      initialHistoryId: profile.historyId,
      nextPageToken: null,
      lastError: null,
    };
    await clearGmailIndex();
    await setGmailScanState(state);
  }

  const page = await fetchGmailIndexPage(state.nextPageToken, accessToken);
  const ids = (page.messages || []).map((message) => message.id).filter(Boolean);
  const records = await fetchGmailIndexBatch(ids, accessToken);
  if (gmailScanCancelled) return state;
  await ensureGmailConnected();
  await writeGmailIndexMessages(records.map(getGmailIndexRecord));
  const nextPageToken = page.nextPageToken || null;
  const updatedState = {
    ...state,
    status: nextPageToken ? "scanning" : "syncing_changes",
    nextPageToken,
    indexedCount: await getGmailIndexCount(),
    lastError: null,
  };

  if (nextPageToken) {
    await setGmailScanState(updatedState);
    createGmailScanAlarm(1);
    return updatedState;
  }

  let historyId;
  try {
    historyId = await syncGmailHistory(state.initialHistoryId, accessToken);
  } catch (error) {
    if (error.status !== 404) throw error;
    const profile = await getGmailProfile(accessToken);
    await clearGmailIndex();
    const restartState = {
      ...updatedState,
      status: "scanning",
      initialScanStarted: true,
      initialHistoryId: profile.historyId,
      nextPageToken: null,
      indexedCount: 0,
    };
    await setGmailScanState(restartState);
    createGmailScanAlarm(1);
    return restartState;
  }
  return {
    ...updatedState,
    status: "ready",
    initialScanStarted: false,
    initialHistoryId: null,
    historyId,
    nextPageToken: null,
    indexedCount: await getGmailIndexCount(),
    lastScanAt: new Date().toISOString(),
  };
}

async function getGmailIndexCount() {
  const database = await openGmailIndex();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("messages", "readonly");
      const request = transaction.objectStore("messages").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not count indexed messages."));
    });
  } finally {
    database.close();
  }
}

async function performGmailInboxScan() {
  await ensureGmailConnected();
  const accessToken = await getGoogleAccessToken(
    ["https://www.googleapis.com/auth/gmail.readonly"],
    false
  );
  let state = await getGmailScanState();
  state = { ...state, status: "scanning", lastError: null };
  await setGmailScanState(state);

  try {
    if (!state.historyId || state.initialScanStarted) {
      state = await fullGmailInboxScan(accessToken, state);
    } else {
      try {
        const historyId = await syncGmailHistory(state.historyId, accessToken);
        state = {
          ...state,
          historyId,
          status: "ready",
          lastScanAt: new Date().toISOString(),
          indexedCount: await getGmailIndexCount(),
          lastError: null,
        };
      } catch (error) {
        if (error.status !== 404) throw error;
        state = {
          ...state,
          historyId: null,
          initialScanStarted: false,
          nextPageToken: null,
        };
        state = await fullGmailInboxScan(accessToken, state);
      }
    }
    if (!gmailScanCancelled) await setGmailScanState(state);
  } catch (error) {
    const failedState = {
      ...state,
      status: "error",
      lastError: error.message || "Gmail scan failed.",
    };
    await setGmailScanState(failedState);
    throw error;
  }
}

function scanGmailInbox() {
  if (gmailScanPromise) return gmailScanPromise;
  gmailScanCancelled = false;
  gmailScanPromise = performGmailInboxScan()
    .finally(() => {
      gmailScanPromise = null;
      gmailScanCancelled = false;
    });
  return gmailScanPromise;
}

async function startGmailIndexing() {
  await chrome.storage.local.set({
    gmailScanState: {
      status: "queued",
      indexedCount: 0,
      lastScanAt: null,
      lastError: null,
      initialScanStarted: false,
      initialHistoryId: null,
      nextPageToken: null,
      historyId: null,
    },
  });
  createGmailScanAlarm(0.5);
  scanGmailInbox().catch((error) => {
    console.error("Exelidoc Gmail: initial inbox scan failed", error.message);
  });
}

async function stopGmailIndexing() {
  gmailScanCancelled = true;
  await chrome.alarms.clear(GMAIL_SCAN_ALARM);
  if (gmailScanPromise) {
    try {
      await gmailScanPromise;
    } catch (error) {
      console.warn("Exelidoc Gmail: scan stopped after an error", error.message);
    }
  }
  await clearGmailIndex();
  await chrome.storage.local.remove(["gmailScanState"]);
  return new Promise((resolve, reject) => {
    chrome.identity.clearAllCachedAuthTokens(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      chrome.storage.local.remove(["googleDataConnected", "googleAccessConfigVersion"], resolve);
    });
  });
}

async function registerGmailScanAlarm() {
  const { googleDataConnected } = await chrome.storage.local.get("googleDataConnected");
  if (googleDataConnected) await ensureGmailIndexScanScheduled();
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === GMAIL_SCAN_ALARM) {
      scanGmailInbox().catch((error) => {
        console.error("Exelidoc Gmail: scheduled inbox scan failed", error.message);
      });
    }
  });
}

chrome.runtime.onInstalled?.addListener(() => {
  registerGmailScanAlarm().catch((error) => {
    console.error("Exelidoc Gmail: could not restore scheduled scan", error.message);
  });
});
chrome.runtime.onStartup?.addListener(() => {
  registerGmailScanAlarm().catch((error) => {
    console.error("Exelidoc Gmail: could not restore scheduled scan", error.message);
  });
});
async function getGoogleDocSource(file, accessToken) {
  const document = await getGoogleDocument(file.id, accessToken);
  return {
    type: "document",
    title: file.name,
    url: file.webViewLink || `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/edit`,
    content: getDocumentPlainText(document).slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
    sourceRef: { provider: "google", kind: "google_document", id: file.id },
  };
}

async function getGooglePresentationSource(file, accessToken) {
  const presentation = await getGooglePresentation(file.id, accessToken);
  return {
    type: "presentation",
    title: file.name || presentation.title || "Google Slides",
    url: file.webViewLink || getGooglePresentationUrl(file.id),
    content: extractGooglePresentationText(presentation).slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
    sourceRef: { provider: "google", kind: "google_presentation", id: file.id },
  };
}

function getGooglePresentationUrl(presentationId) {
  return `https://docs.google.com/presentation/d/${encodeURIComponent(presentationId)}/edit`;
}

async function getGooglePresentation(presentationId, accessToken) {
  return googleApiRequest(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}?fields=title,slides(pageElements(shape(text(textElements(textRun(content)))),table(tableRows(tableCells(text(textElements(textRun(content))))))))`,
    accessToken
  );
}

function extractGooglePresentationText(presentation) {
  const textRuns = [];
  function collectTextRuns(value) {
    if (Array.isArray(value)) {
      value.forEach(collectTextRuns);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.textRun?.content === "string") {
      textRuns.push(value.textRun.content);
    }
    Object.values(value).forEach(collectTextRuns);
  }
  collectTextRuns(presentation.slides || []);
  return textRuns.join("");
}

async function getGoogleSheetSource(file, accessToken) {
  const metadata = await googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.id)}?fields=properties(title),sheets(properties(title))`,
    accessToken
  );
  const sheets = (metadata.sheets || []).slice(0, 5);
  const sections = await Promise.all(sheets.map(async (sheet) => {
    const title = sheet.properties?.title;
    if (!title) return "";
    const range = `'${title.replace(/'/g, "''")}'!A1:Z100`;
    const values = await googleApiRequest(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
      accessToken
    );
    const rows = (values.values || []).map((row) => row.join("\t")).filter((row) => row.trim());
    return rows.length ? `${title}\n${rows.join("\n")}` : "";
  }));
  return {
    type: "spreadsheet",
    title: file.name || metadata.properties?.title || "Google Sheet",
    url: file.webViewLink || `https://docs.google.com/spreadsheets/d/${encodeURIComponent(file.id)}/edit`,
    content: sections.filter(Boolean).join("\n\n").slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
    spreadsheetId: file.id,
    sheetTitles: sheets.map((sheet) => sheet.properties?.title).filter(Boolean),
    sourceRef: { provider: "google", kind: "google_spreadsheet", id: file.id },
  };
}

async function getGoogleSourceForRef(sourceRef, accessToken) {
  if (
    !sourceRef
    || sourceRef.provider !== "google"
    || !/^[A-Za-z0-9_-]{1,256}$/.test(sourceRef.id || "")
  ) {
    throw new Error("A saved Google source reference is invalid.");
  }
  if (sourceRef.kind === "gmail_message") {
    return makeGmailSource(await getGmailMessage(sourceRef.id, accessToken));
  }
  if (sourceRef.kind === "google_document") {
    const document = await getGoogleDocument(sourceRef.id, accessToken);
    return {
      type: "document",
      title: document.title || "Google Docs",
      url: `https://docs.google.com/document/d/${encodeURIComponent(sourceRef.id)}/edit`,
      content: getDocumentPlainText(document).slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
      sourceRef,
    };
  }
  if (sourceRef.kind === "google_spreadsheet") {
    return getGoogleSheetSource({ id: sourceRef.id }, accessToken);
  }
  if (sourceRef.kind === "google_presentation") {
    const presentation = await getGooglePresentation(sourceRef.id, accessToken);
    return {
      type: "presentation",
      title: presentation.title || "Google Slides",
      url: getGooglePresentationUrl(sourceRef.id),
      content: extractGooglePresentationText(presentation).slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
      sourceRef,
    };
  }
  throw new Error("This history entry does not contain a supported Google source.");
}

function googleColumnIndex(letters) {
  return letters.split("").reduce((index, letter) => (
    index * 26 + letter.charCodeAt(0) - 64
  ), 0);
}

function parseGoogleSheetRange(range) {
  if (typeof range !== "string") {
    throw new Error("Enter a rectangular cell range, such as A1:D20.");
  }
  const match = range.trim().toUpperCase().match(/^([A-Z]{1,3})([1-9]\d{0,5}):([A-Z]{1,3})([1-9]\d{0,5})$/);
  if (!match) {
    throw new Error("Enter a rectangular cell range, such as A1:D20.");
  }
  const startColumn = googleColumnIndex(match[1]);
  const startRow = Number(match[2]);
  const endColumn = googleColumnIndex(match[3]);
  const endRow = Number(match[4]);
  const rowCount = endRow - startRow + 1;
  const columnCount = endColumn - startColumn + 1;
  if (
    rowCount < 1
    || columnCount < 1
    || rowCount * columnCount > GOOGLE_SHEET_EDIT_MAX_CELLS
  ) {
    throw new Error(`Choose a valid range containing no more than ${GOOGLE_SHEET_EDIT_MAX_CELLS} cells.`);
  }
  return { startRow, startColumn, rowCount, columnCount };
}

function normalizeGoogleSheetValues(values, rowCount, columnCount) {
  return Array.from({ length: rowCount }, (_row, rowIndex) => (
    Array.from({ length: columnCount }, (_cell, columnIndex) => (
      values[rowIndex]?.[columnIndex] ?? null
    ))
  ));
}

function getGoogleSheetRangeUrl(spreadsheetId, sheetTitle, range, valueRenderOption = "FORMULA") {
  const quotedTitle = `'${sheetTitle.replace(/'/g, "''")}'`;
  const qualifiedRange = `${quotedTitle}!${range}`;
  return {
    qualifiedRange,
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(qualifiedRange)}?valueRenderOption=${valueRenderOption}`,
  };
}

async function getGoogleSheetMetadata(spreadsheetId, accessToken) {
  if (typeof spreadsheetId !== "string" || !/^[\w-]{1,256}$/.test(spreadsheetId)) {
    throw new Error("The selected spreadsheet could not be verified.");
  }
  return googleApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),bandedRanges(bandedRangeId,range))`,
    accessToken
  );
}

function verifyGoogleSheetSender(spreadsheetId, sender) {
  if (typeof spreadsheetId !== "string" || !/^[\w-]{1,256}$/.test(spreadsheetId)) {
    throw new Error("The selected spreadsheet could not be verified.");
  }
  if (!sender?.url) return spreadsheetId;
  let senderUrl;
  try {
    senderUrl = new URL(sender.url);
  } catch (error) {
    throw new Error("Open a Google Sheets spreadsheet and try again.");
  }
  if (senderUrl.protocol === "chrome-extension:" && sender.id === chrome.runtime.id) {
    return spreadsheetId;
  }
  const match = senderUrl.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/);
  if (senderUrl.hostname !== "docs.google.com" || !match || match[1] !== spreadsheetId) {
    throw new Error("The active Google Sheets spreadsheet could not be verified. Refresh the sheet and try again.");
  }
  return spreadsheetId;
}

function getGoogleSheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

async function getGoogleSheetInfo(message, sender) {
  const spreadsheetId = verifyGoogleSheetSender(message.spreadsheetId, sender);
  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const metadata = await getGoogleSheetMetadata(spreadsheetId, accessToken);
  return {
    spreadsheetId,
    title: metadata.properties?.title || "Google Sheet",
    sheets: (metadata.sheets || []).map((sheet) => ({
      title: sheet.properties?.title,
      sheetId: sheet.properties?.sheetId,
      gridProperties: sheet.properties?.gridProperties,
    })).filter((sheet) => sheet.title),
    url: getGoogleSheetUrl(spreadsheetId),
  };
}

async function readGoogleSheetEditRange(message, sender) {
  const spreadsheetId = verifyGoogleSheetSender(message.spreadsheetId, sender);
  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const metadata = await getGoogleSheetMetadata(spreadsheetId, accessToken);
  const titles = (metadata.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  if (typeof message.sheetTitle !== "string" || !titles.includes(message.sheetTitle)) {
    throw new Error("The selected sheet tab could not be verified. Search again and retry.");
  }
  const dimensions = parseGoogleSheetRange(message.range);
  const { qualifiedRange, url } = getGoogleSheetRangeUrl(
    spreadsheetId,
    message.sheetTitle,
    message.range.trim().toUpperCase()
  );
  const data = await googleApiRequest(url, accessToken);
  return {
    snapshot: {
      spreadsheetId,
      sheetTitle: message.sheetTitle,
      range: message.range.trim().toUpperCase(),
      qualifiedRange,
      dimensions,
      values: normalizeGoogleSheetValues(data.values || [], dimensions.rowCount, dimensions.columnCount),
    },
  };
}

async function generateGoogleSheetEdit(message, sender) {
  const snapshot = message.snapshot;
  const spreadsheetId = verifyGoogleSheetSender(snapshot?.spreadsheetId, sender);
  const dimensions = parseGoogleSheetRange(snapshot.range);
  if (
    !Array.isArray(snapshot.values)
    || snapshot.values.length !== dimensions.rowCount
    || snapshot.values.some((row) => !Array.isArray(row) || row.length !== dimensions.columnCount)
    || snapshot.values.some((row) => row.some((value) => !isGoogleSheetScalar(value)))
    || typeof message.instruction !== "string"
    || !message.instruction.trim()
    || message.instruction.length > 10000
  ) {
    throw new Error("Load a valid cell range and enter an edit instruction.");
  }
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) throw new Error("Sign in to Exelidoc from the toolbar popup first.");
  const sourceUrl = getGoogleSheetUrl(spreadsheetId);
  const gmailContext = await getSelectedGmailContext(message.gmailSourceRefs);
  const sourceRefs = [
    { provider: "google", kind: "google_spreadsheet", id: spreadsheetId },
    ...gmailContext.sourceRefs,
  ];
  const response = await fetch(`${BACKEND_URL}/api/ai/edit-range`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      values: snapshot.values,
      instruction: message.instruction,
      context: gmailContext.context,
      source_url: sourceUrl,
      source_urls: [sourceUrl, ...gmailContext.sources.map((source) => source.url)],
      source_refs: sourceRefs,
      client: "chrome",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
  return { data };
}

function isGoogleFormula(value) {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

function isGoogleSheetScalar(value) {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

async function applyGoogleSheetEdit(message, sender) {
  const snapshot = message.snapshot;
  verifyGoogleSheetSender(snapshot?.spreadsheetId, sender);
  if (
    !snapshot
    || typeof snapshot.spreadsheetId !== "string"
    || typeof snapshot.sheetTitle !== "string"
    || typeof snapshot.range !== "string"
    || !Array.isArray(snapshot.values)
    || !Array.isArray(message.correctedValues)
  ) {
    throw new Error("The spreadsheet edit preview is invalid. Load the range again.");
  }
  const dimensions = parseGoogleSheetRange(snapshot.range);
  if (
    snapshot.values.length !== dimensions.rowCount
    || message.correctedValues.length !== dimensions.rowCount
    || snapshot.values.some((row) => !Array.isArray(row) || row.length !== dimensions.columnCount)
    || message.correctedValues.some((row) => !Array.isArray(row) || row.length !== dimensions.columnCount)
    || [...snapshot.values, ...message.correctedValues].some((row) => row.some((value) => !isGoogleSheetScalar(value)))
  ) {
    throw new Error("The spreadsheet edit preview has invalid cell values.");
  }

  const accessToken = await getGoogleAccessToken([GOOGLE_SHEETS_EDIT_SCOPE], true);
  const metadata = await getGoogleSheetMetadata(snapshot.spreadsheetId, accessToken);
  const titles = (metadata.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  if (!titles.includes(snapshot.sheetTitle)) {
    throw new Error("The selected sheet tab no longer exists. Search again and retry.");
  }
  const { qualifiedRange, url } = getGoogleSheetRangeUrl(
    snapshot.spreadsheetId,
    snapshot.sheetTitle,
    snapshot.range
  );
  const currentData = await googleApiRequest(url, accessToken);
  const currentValues = normalizeGoogleSheetValues(
    currentData.values || [],
    dimensions.rowCount,
    dimensions.columnCount
  );
  if (JSON.stringify(currentValues) !== JSON.stringify(snapshot.values)) {
    throw new Error("The sheet changed after the preview. Reload the range and create a new preview.");
  }

  const updates = [];
  let formulaChanges = 0;
  for (let row = 0; row < dimensions.rowCount; row += 1) {
    for (let column = 0; column < dimensions.columnCount; column += 1) {
      const before = snapshot.values[row][column];
      const after = message.correctedValues[row][column];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const beforeIsFormula = isGoogleFormula(before);
      const formula = isGoogleFormula(after);
      if (beforeIsFormula || formula) formulaChanges += 1;
      updates.push({
        rowIndex: dimensions.startRow - 1 + row,
        columnIndex: dimensions.startColumn - 1 + column,
        value: after,
        formula,
      });
    }
  }
  if (!updates.length) {
    return { ok: true, updatedCells: 0, formulaChanges: 0 };
  }
  if (formulaChanges > 0 && message.confirmFormulaChanges !== true) {
    throw new Error("Confirm the reviewed formula changes before applying them.");
  }

  const groupedUpdates = [];
  updates.forEach((update) => {
    const previous = groupedUpdates[groupedUpdates.length - 1];
    if (
      previous
      && previous.rowIndex === update.rowIndex
      && previous.startColumnIndex + previous.values.length === update.columnIndex
    ) {
      previous.values.push(update.value);
    } else {
      groupedUpdates.push({
        rowIndex: update.rowIndex,
        startColumnIndex: update.columnIndex,
        values: [update.value],
      });
    }
  });
  if (groupedUpdates.length > 1000) {
    throw new Error("This edit contains too many separate cell changes. Narrow the range and create a smaller preview.");
  }

  const sheet = (metadata.sheets || []).find(
    (candidate) => candidate.properties?.title === snapshot.sheetTitle
  );
  if (!Number.isInteger(sheet?.properties?.sheetId)) {
    throw new Error("The selected sheet tab could not be verified. Search again and retry.");
  }
  await readGoogleApiResponse(await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(snapshot.spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: groupedUpdates.map((group) => ({
          updateCells: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: group.rowIndex,
              endRowIndex: group.rowIndex + 1,
              startColumnIndex: group.startColumnIndex,
              endColumnIndex: group.startColumnIndex + group.values.length,
            },
            rows: [{
              values: group.values.map((value) => {
                if (value === null) return {};
                if (isGoogleFormula(value)) {
                  return { userEnteredValue: { formulaValue: value.trimStart() } };
                }
                if (typeof value === "string") {
                  return { userEnteredValue: { stringValue: value } };
                }
                if (typeof value === "boolean") {
                  return { userEnteredValue: { boolValue: value } };
                }
                return { userEnteredValue: { numberValue: value } };
              }),
            }],
            fields: "userEnteredValue",
          },
        })),
      }),
    }
  ));
  return { ok: true, updatedCells: updates.length, formulaChanges };
}

const GOOGLE_SHEET_FORMAT_ENUMS = {
  headerAlignment: ["LEFT", "CENTER", "RIGHT"],
  horizontalAlignment: ["LEFT", "CENTER", "RIGHT"],
  numberFormat: ["CURRENCY", "PERCENT", "DATE", "NUMBER"],
};

const GOOGLE_SHEET_FORMAT_BOOLS = [
  "headerStyle",
  "alternatingRows",
  "freezeHeaderRow",
  "autoResizeColumns",
  "borders",
  "bold",
  "italic",
  "wrapText",
];

const GOOGLE_SHEET_FORMAT_COLORS = [
  "headerBackgroundColor",
  "headerTextColor",
  "textColor",
  "backgroundColor",
];

const GOOGLE_SHEET_FORMAT_SIZES = ["headerFontSize", "fontSize"];

function validateGoogleSheetFormatting(formatting, requireChanges = true) {
  if (!formatting || typeof formatting !== "object" || Array.isArray(formatting)) {
    throw new Error("The formatting preview is invalid. Generate it again.");
  }
  const allowedFields = new Set([
    ...GOOGLE_SHEET_FORMAT_BOOLS,
    ...GOOGLE_SHEET_FORMAT_COLORS,
    ...GOOGLE_SHEET_FORMAT_SIZES,
    ...Object.keys(GOOGLE_SHEET_FORMAT_ENUMS),
  ]);
  if (Object.keys(formatting).some((key) => !allowedFields.has(key))) {
    throw new Error("The formatting preview contains unsupported changes.");
  }
  GOOGLE_SHEET_FORMAT_BOOLS.forEach((key) => {
    if (key in formatting && typeof formatting[key] !== "boolean") {
      throw new Error("The formatting preview contains an invalid option.");
    }
  });
  GOOGLE_SHEET_FORMAT_COLORS.forEach((key) => {
    if (key in formatting && (
      typeof formatting[key] !== "string"
      || !/^#[0-9a-f]{6}$/i.test(formatting[key])
    )) {
      throw new Error("The formatting preview contains an invalid color.");
    }
  });
  GOOGLE_SHEET_FORMAT_SIZES.forEach((key) => {
    if (key in formatting && (
      !Number.isInteger(formatting[key])
      || formatting[key] < 8
      || formatting[key] > 24
    )) {
      throw new Error("The formatting preview contains an invalid font size.");
    }
  });
  Object.entries(GOOGLE_SHEET_FORMAT_ENUMS).forEach(([key, choices]) => {
    if (key in formatting && !choices.includes(formatting[key])) {
      throw new Error("The formatting preview contains an unsupported format.");
    }
  });
  const hasChanges = Object.entries(formatting).some(([key, value]) => (
    GOOGLE_SHEET_FORMAT_BOOLS.includes(key) ? value === true : value != null
  ));
  if (requireChanges && !hasChanges) {
    throw new Error("Choose a formatting option or describe a custom format.");
  }
  return formatting;
}

function googleSheetRgb(hex) {
  const value = hex.replace("#", "");
  return {
    red: parseInt(value.slice(0, 2), 16) / 255,
    green: parseInt(value.slice(2, 4), 16) / 255,
    blue: parseInt(value.slice(4, 6), 16) / 255,
  };
}

function googleSheetNumberFormat(value) {
  const formats = {
    CURRENCY: { type: "CURRENCY" },
    PERCENT: { type: "PERCENT", pattern: "0.00%" },
    DATE: { type: "DATE", pattern: "yyyy-mm-dd" },
    NUMBER: { type: "NUMBER", pattern: "#,##0.##" },
  };
  return formats[value];
}

function googleSheetFormatCellFields(formatting, header = false) {
  const userEnteredFormat = {};
  const fields = [];
  const addField = (path) => fields.push(`userEnteredFormat.${path}`);
  const color = (key) => (
    formatting[key] ? googleSheetRgb(formatting[key]) : undefined
  );
  const textFormat = {};

  if (header) {
    if (formatting.headerStyle === true) {
      userEnteredFormat.backgroundColor = googleSheetRgb(
        formatting.headerBackgroundColor || "#3548C8"
      );
      textFormat.bold = true;
      textFormat.foregroundColor = googleSheetRgb(formatting.headerTextColor || "#FFFFFF");
      addField("backgroundColor");
      addField("textFormat.bold");
      addField("textFormat.foregroundColor");
    } else {
      if (formatting.headerBackgroundColor) {
        userEnteredFormat.backgroundColor = color("headerBackgroundColor");
        addField("backgroundColor");
      }
      if (formatting.headerTextColor) {
        textFormat.foregroundColor = color("headerTextColor");
        addField("textFormat.foregroundColor");
      }
    }
    if (formatting.headerFontSize) {
      textFormat.fontSize = formatting.headerFontSize;
      addField("textFormat.fontSize");
    }
    if (formatting.headerAlignment) {
      userEnteredFormat.horizontalAlignment = formatting.headerAlignment;
      addField("horizontalAlignment");
    }
  } else {
    if ("bold" in formatting) {
      textFormat.bold = formatting.bold;
      addField("textFormat.bold");
    }
    if ("italic" in formatting) {
      textFormat.italic = formatting.italic;
      addField("textFormat.italic");
    }
    if (formatting.fontSize) {
      textFormat.fontSize = formatting.fontSize;
      addField("textFormat.fontSize");
    }
    if (formatting.textColor) {
      textFormat.foregroundColor = color("textColor");
      addField("textFormat.foregroundColor");
    }
    if (formatting.backgroundColor) {
      userEnteredFormat.backgroundColor = color("backgroundColor");
      addField("backgroundColor");
    }
    if (formatting.horizontalAlignment) {
      userEnteredFormat.horizontalAlignment = formatting.horizontalAlignment;
      addField("horizontalAlignment");
    }
    if ("wrapText" in formatting) {
      userEnteredFormat.wrapStrategy = formatting.wrapText ? "WRAP" : "OVERFLOW_CELL";
      addField("wrapStrategy");
    }
    if (formatting.numberFormat) {
      userEnteredFormat.numberFormat = googleSheetNumberFormat(formatting.numberFormat);
      addField("numberFormat");
    }
    if (formatting.borders) {
      const border = {
        style: "SOLID",
        color: googleSheetRgb("#DADCE0"),
      };
      userEnteredFormat.borders = {
        top: border,
        bottom: border,
        left: border,
        right: border,
      };
      addField("borders");
    }
  }

  if (Object.keys(textFormat).length) {
    userEnteredFormat.textFormat = textFormat;
  }
  if (!fields.length) return null;
  return { userEnteredFormat, fields: [...new Set(fields)] };
}

function gridRangesOverlap(first, second) {
  return first.sheetId === second.sheetId
    && (first.startRowIndex || 0) < (second.endRowIndex ?? Infinity)
    && (second.startRowIndex || 0) < (first.endRowIndex ?? Infinity)
    && (first.startColumnIndex || 0) < (second.endColumnIndex ?? Infinity)
    && (second.startColumnIndex || 0) < (first.endColumnIndex ?? Infinity);
}

function sameGoogleSheetGridRange(first, second) {
  return first.sheetId === second.sheetId
    && (first.startRowIndex || 0) === (second.startRowIndex || 0)
    && (first.endRowIndex ?? null) === (second.endRowIndex ?? null)
    && (first.startColumnIndex || 0) === (second.startColumnIndex || 0)
    && (first.endColumnIndex ?? null) === (second.endColumnIndex ?? null);
}

function getGoogleSheetFormatRange(sheet, snapshot, scope) {
  if (scope === "sheet") {
    const grid = sheet.properties?.gridProperties;
    if (!Number.isInteger(grid?.rowCount) || !Number.isInteger(grid?.columnCount)) {
      throw new Error("The active sheet size could not be verified. Reload and try again.");
    }
    return {
      sheetId: sheet.properties.sheetId,
      startRowIndex: 0,
      endRowIndex: grid.rowCount,
      startColumnIndex: 0,
      endColumnIndex: grid.columnCount,
    };
  }
  if (scope !== "range") {
    throw new Error("Choose the highlighted range or the entire active sheet.");
  }
  const dimensions = parseGoogleSheetRange(snapshot.range);
  return {
    sheetId: sheet.properties.sheetId,
    startRowIndex: dimensions.startRow - 1,
    endRowIndex: dimensions.startRow - 1 + dimensions.rowCount,
    startColumnIndex: dimensions.startColumn - 1,
    endColumnIndex: dimensions.startColumn - 1 + dimensions.columnCount,
  };
}

function buildGoogleSheetFormattingRequests(sheet, snapshot, scope, formatting) {
  validateGoogleSheetFormatting(formatting);
  const range = getGoogleSheetFormatRange(sheet, snapshot, scope);
  const requests = [];
  let bandingRequest = null;

  if (formatting.alternatingRows) {
    const banding = {
      headerColor: formatting.headerStyle === true
        ? googleSheetRgb(formatting.headerBackgroundColor || "#3548C8")
        : undefined,
      firstBandColor: googleSheetRgb("#FFFFFF"),
      secondBandColor: googleSheetRgb("#EEF1FF"),
    };
    Object.keys(banding).forEach((key) => {
      if (banding[key] === undefined) delete banding[key];
    });
    const overlaps = (sheet.bandedRanges || [])
      .filter((item) => item.range && gridRangesOverlap(item.range, range));
    if (overlaps.length > 1 || overlaps.some((item) => !sameGoogleSheetGridRange(item.range, range))) {
      throw new Error("Alternating colors overlap existing banding. Remove the existing banding in Google Sheets first.");
    }
    if (overlaps.length === 1) {
      const bandedRangeId = overlaps[0].bandedRangeId;
      if (!Number.isInteger(bandedRangeId)) {
        throw new Error("Existing alternating colors could not be verified. Remove them in Google Sheets and retry.");
      }
      bandingRequest = {
        updateBanding: {
          bandedRange: { bandedRangeId, rowProperties: banding },
          fields: [
            ...(banding.headerColor ? ["rowProperties.headerColor"] : []),
            "rowProperties.firstBandColor",
            "rowProperties.secondBandColor",
          ].join(","),
        },
      };
    } else {
      bandingRequest = { addBanding: { bandedRange: { range, rowProperties: banding } } };
    }
  }

  const bodyFormat = googleSheetFormatCellFields(formatting);
  if (bodyFormat) {
    requests.push({
      repeatCell: {
        range,
        cell: { userEnteredFormat: bodyFormat.userEnteredFormat },
        fields: bodyFormat.fields.join(","),
      },
    });
  }

  if (bandingRequest) requests.push(bandingRequest);

  const headerFormat = googleSheetFormatCellFields(formatting, true);
  if (headerFormat) {
    requests.push({
      repeatCell: {
        range: {
          ...range,
          endRowIndex: range.startRowIndex + 1,
        },
        cell: { userEnteredFormat: headerFormat.userEnteredFormat },
        fields: headerFormat.fields.join(","),
      },
    });
  }

  if (formatting.freezeHeaderRow) {
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: range.sheetId,
          gridProperties: {
            frozenRowCount: scope === "range" ? range.startRowIndex + 1 : 1,
          },
        },
        fields: "gridProperties.frozenRowCount",
      },
    });
  }

  if (formatting.autoResizeColumns) {
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: range.sheetId,
          dimension: "COLUMNS",
          startIndex: range.startColumnIndex,
          endIndex: range.endColumnIndex,
        },
      },
    });
  }

  return requests;
}

async function generateGoogleSheetFormatting(message, sender) {
  const snapshot = message.snapshot;
  const spreadsheetId = verifyGoogleSheetSender(snapshot?.spreadsheetId, sender);
  const dimensions = parseGoogleSheetRange(snapshot.range);
  if (
    !Array.isArray(snapshot.values)
    || snapshot.values.length !== dimensions.rowCount
    || snapshot.values.some((row) => !Array.isArray(row) || row.length !== dimensions.columnCount)
    || snapshot.values.some((row) => row.some((value) => !isGoogleSheetScalar(value)))
    || typeof message.instruction !== "string"
    || message.instruction.length > 10000
    || !message.options
    || typeof message.options !== "object"
    || Array.isArray(message.options)
  ) {
    throw new Error("Load a valid cell range and formatting options first.");
  }
  const options = { ...message.options };
  const scope = options.scope;
  delete options.scope;
  validateGoogleSheetFormatting(options, false);
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) throw new Error("Sign in to Exelidoc from the toolbar popup first.");
  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const metadata = await getGoogleSheetMetadata(spreadsheetId, accessToken);
  const sheet = (metadata.sheets || []).find(
    (candidate) => candidate.properties?.title === snapshot.sheetTitle
  );
  if (!Number.isInteger(sheet?.properties?.sheetId)) {
    throw new Error("The selected sheet tab could not be verified. Search again and retry.");
  }
  getGoogleSheetFormatRange(sheet, snapshot, scope);

  let customFormatting = {};
  let notes = [];
  const instruction = message.instruction.trim();
  if (instruction) {
    const sourceUrl = getGoogleSheetUrl(spreadsheetId);
    const response = await fetch(`${BACKEND_URL}/api/ai/format-range`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": sessionToken,
      },
      body: JSON.stringify({
        values: snapshot.values,
        instruction,
        source_url: sourceUrl,
        source_urls: [sourceUrl],
        source_refs: [{ provider: "google", kind: "google_spreadsheet", id: spreadsheetId }],
        client: "chrome",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
    customFormatting = validateGoogleSheetFormatting(data.formatting);
    notes = Array.isArray(data.notes) ? data.notes : [];
  }

  const formatting = validateGoogleSheetFormatting({ ...customFormatting, ...options });
  const requests = buildGoogleSheetFormattingRequests(sheet, snapshot, scope, formatting);
  if (requests.some((request) => request.updateBanding)) {
    notes.push("Existing alternating row colors in this target will be updated.");
  }
  return {
    formatting,
    scope,
    requestCount: requests.length,
    notes,
  };
}

async function applyGoogleSheetFormatting(message, sender) {
  const snapshot = message.snapshot;
  verifyGoogleSheetSender(snapshot?.spreadsheetId, sender);
  if (
    !snapshot
    || typeof snapshot.spreadsheetId !== "string"
    || typeof snapshot.sheetTitle !== "string"
    || typeof snapshot.range !== "string"
    || !Array.isArray(snapshot.values)
  ) {
    throw new Error("The formatting preview is invalid. Load the range again.");
  }
  const dimensions = parseGoogleSheetRange(snapshot.range);
  if (
    snapshot.values.length !== dimensions.rowCount
    || snapshot.values.some((row) => !Array.isArray(row) || row.length !== dimensions.columnCount)
    || snapshot.values.some((row) => row.some((value) => !isGoogleSheetScalar(value)))
  ) {
    throw new Error("The formatting preview has invalid cell values.");
  }
  const formatting = validateGoogleSheetFormatting(message.formatting);
  const accessToken = await getGoogleAccessToken([GOOGLE_SHEETS_EDIT_SCOPE], true);
  const metadata = await getGoogleSheetMetadata(snapshot.spreadsheetId, accessToken);
  const sheet = (metadata.sheets || []).find(
    (candidate) => candidate.properties?.title === snapshot.sheetTitle
  );
  if (!Number.isInteger(sheet?.properties?.sheetId)) {
    throw new Error("The selected sheet tab no longer exists. Search again and retry.");
  }
  const { url } = getGoogleSheetRangeUrl(
    snapshot.spreadsheetId,
    snapshot.sheetTitle,
    snapshot.range
  );
  const currentData = await googleApiRequest(url, accessToken);
  const currentValues = normalizeGoogleSheetValues(
    currentData.values || [],
    dimensions.rowCount,
    dimensions.columnCount
  );
  if (JSON.stringify(currentValues) !== JSON.stringify(snapshot.values)) {
    throw new Error("The sheet changed after the formatting preview. Reload the range and preview again.");
  }
  const requests = buildGoogleSheetFormattingRequests(
    sheet,
    snapshot,
    message.scope,
    formatting
  );
  await readGoogleApiResponse(await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(snapshot.spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    }
  ));
  return { ok: true, formattingChanges: requests.length };
}

async function getGoogleDriveSearchResults(query, accessToken) {
  const params = new URLSearchParams({
    q: driveQueryForTerms(query),
    pageSize: String(GOOGLE_SOURCE_LIMIT),
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
  });
  const list = await googleApiRequest(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    accessToken
  );
  return Promise.all((list.files || []).map((file) => {
    if (file.mimeType === "application/vnd.google-apps.document") {
      return getGoogleDocSource(file, accessToken);
    }
    if (file.mimeType === "application/vnd.google-apps.presentation") {
      return getGooglePresentationSource(file, accessToken);
    }
    return getGoogleSheetSource(file, accessToken);
  }));
}

async function searchGoogleSources(query) {
  if (typeof query !== "string" || !query.trim() || query.length > 200) {
    throw new Error("Enter a search query of 1 to 200 characters.");
  }
  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const [indexedEmails, searchedEmails, files] = await Promise.all([
    getGmailIndexSearchResults(query.trim()),
    getGmailSearchResults(query.trim(), accessToken),
    getGoogleDriveSearchResults(query.trim(), accessToken),
  ]);
  const seenMessageIds = new Set();
  const emails = [...indexedEmails, ...searchedEmails]
    .filter((source) => {
      const id = source.sourceRef?.id;
      if (id && seenMessageIds.has(id)) return false;
      if (id) seenMessageIds.add(id);
      return true;
    })
    .slice(0, GOOGLE_SOURCE_LIMIT);
  return [...emails, ...files]
    .filter((source) => source.content && source.content.trim())
    .slice(0, GOOGLE_SOURCE_LIMIT * 2);
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

function getGoogleDocumentParagraphs(document) {
  const paragraphs = (document.body?.content || [])
    .filter((item) => item.paragraph)
    .map((item) => ({
      startIndex: item.startIndex,
      endIndex: item.endIndex,
      text: (item.paragraph.elements || [])
        .map((element) => element.textRun?.content || "")
        .join("")
        .replace(/\n$/, ""),
    }));
  if (
    !paragraphs.length
    || paragraphs.some((paragraph) => (
      !Number.isInteger(paragraph.startIndex)
      || !Number.isInteger(paragraph.endIndex)
      || paragraph.startIndex < 1
      || paragraph.endIndex <= paragraph.startIndex
    ))
  ) {
    throw new Error("Google Docs did not return valid paragraph ranges to format.");
  }
  return paragraphs;
}

function mergeGoogleDocsFormatting(target, addition) {
  const result = {
    textStyle: { ...(target.textStyle || {}), ...(addition.textStyle || {}) },
    paragraphStyle: { ...(target.paragraphStyle || {}), ...(addition.paragraphStyle || {}) },
    paragraphStyles: [...(target.paragraphStyles || [])],
  };
  (addition.paragraphStyles || []).forEach((item) => {
    const existing = result.paragraphStyles.find((entry) => entry.paragraphIndex === item.paragraphIndex);
    if (!existing) {
      result.paragraphStyles.push({
        paragraphIndex: item.paragraphIndex,
        ...(item.textStyle ? { textStyle: { ...item.textStyle } } : {}),
        ...(item.paragraphStyle ? { paragraphStyle: { ...item.paragraphStyle } } : {}),
      });
      return;
    }
    if (item.textStyle) existing.textStyle = { ...(existing.textStyle || {}), ...item.textStyle };
    if (item.paragraphStyle) {
      existing.paragraphStyle = { ...(existing.paragraphStyle || {}), ...item.paragraphStyle };
    }
  });
  if (!Object.keys(result.textStyle).length) delete result.textStyle;
  if (!Object.keys(result.paragraphStyle).length) delete result.paragraphStyle;
  if (!result.paragraphStyles.length) delete result.paragraphStyles;
  return result;
}

function getGoogleDocsQuickFormatting(options) {
  const allowedOptions = new Set(["title", "body", "center", "justify", "spacing"]);
  if (
    !Array.isArray(options)
    || options.length > allowedOptions.size
    || options.some((option) => !allowedOptions.has(option))
    || new Set(options).size !== options.length
  ) {
    throw new Error("Choose valid Google Docs formatting options and try again.");
  }

  const formatting = { textStyle: {}, paragraphStyle: {}, paragraphStyles: [] };
  if (options.includes("body")) {
    Object.assign(formatting.textStyle, { fontFamily: "Arial", fontSize: 11 });
    Object.assign(formatting.paragraphStyle, { namedStyleType: "NORMAL_TEXT", lineSpacing: 115 });
  }
  if (options.includes("center")) formatting.paragraphStyle.alignment = "CENTER";
  if (options.includes("justify")) formatting.paragraphStyle.alignment = "JUSTIFIED";
  if (options.includes("spacing")) formatting.paragraphStyle.lineSpacing = 150;
  if (options.includes("title")) {
    formatting.paragraphStyles.push({
      paragraphIndex: 0,
      textStyle: { fontSize: 24, bold: true },
      paragraphStyle: { namedStyleType: "TITLE" },
    });
  }
  return formatting;
}

function validateGoogleDocsFormatting(formatting, paragraphCount) {
  const textFields = new Set([
    "fontFamily", "fontSize", "foregroundColor", "bold", "italic", "underline", "strikethrough",
  ]);
  const paragraphFields = new Set(["namedStyleType", "alignment", "lineSpacing"]);
  const fontFamilies = new Set([
    "Arial", "Calibri", "Cambria", "Georgia", "Times New Roman",
    "Verdana", "Roboto", "Lato", "Montserrat",
  ]);
  const namedStyles = new Set([
    "NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2",
    "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6",
  ]);
  const alignments = new Set(["START", "CENTER", "END", "JUSTIFIED"]);
  const validTextStyle = (style) => (
    style
    && typeof style === "object"
    && !Array.isArray(style)
    && Object.keys(style).length > 0
    && Object.keys(style).every((key) => textFields.has(key))
    && (!("fontFamily" in style) || fontFamilies.has(style.fontFamily))
    && (!("fontSize" in style) || (Number.isInteger(style.fontSize) && style.fontSize >= 8 && style.fontSize <= 36))
    && (!("foregroundColor" in style) || (typeof style.foregroundColor === "string" && /^#[\da-f]{6}$/i.test(style.foregroundColor)))
    && ["bold", "italic", "underline", "strikethrough"].every((key) => !(key in style) || typeof style[key] === "boolean")
  );
  const validParagraphStyle = (style) => (
    style
    && typeof style === "object"
    && !Array.isArray(style)
    && Object.keys(style).length > 0
    && Object.keys(style).every((key) => paragraphFields.has(key))
    && (!("namedStyleType" in style) || namedStyles.has(style.namedStyleType))
    && (!("alignment" in style) || alignments.has(style.alignment))
    && (!("lineSpacing" in style) || (Number.isInteger(style.lineSpacing) && style.lineSpacing >= 100 && style.lineSpacing <= 300))
  );
  if (
    !formatting
    || typeof formatting !== "object"
    || Array.isArray(formatting)
    || !Object.keys(formatting).length
    || Object.keys(formatting).some((key) => !["textStyle", "paragraphStyle", "paragraphStyles"].includes(key))
    || ("textStyle" in formatting && !validTextStyle(formatting.textStyle))
    || ("paragraphStyle" in formatting && !validParagraphStyle(formatting.paragraphStyle))
  ) {
    throw new Error("The formatting preview is invalid. Generate it again and retry.");
  }
  if ("paragraphStyles" in formatting) {
    const styles = formatting.paragraphStyles;
    if (
      !Array.isArray(styles)
      || !styles.length
      || styles.length > paragraphCount
      || styles.some((item) => (
        !item
        || typeof item !== "object"
        || Array.isArray(item)
        || Object.keys(item).some((key) => !["paragraphIndex", "textStyle", "paragraphStyle"].includes(key))
        || !Number.isInteger(item.paragraphIndex)
        || item.paragraphIndex < 0
        || item.paragraphIndex >= paragraphCount
        || ("textStyle" in item && !validTextStyle(item.textStyle))
        || ("paragraphStyle" in item && !validParagraphStyle(item.paragraphStyle))
        || (!("textStyle" in item) && !("paragraphStyle" in item))
      ))
      || new Set(styles.map((item) => item.paragraphIndex)).size !== styles.length
    ) {
      throw new Error("The formatting preview contains an invalid paragraph target.");
    }
  }
}

function googleDocsTextStyle(style) {
  const result = { ...style };
  if (style.fontFamily) {
    result.weightedFontFamily = { fontFamily: style.fontFamily };
    delete result.fontFamily;
  }
  if (style.fontSize !== undefined) result.fontSize = { magnitude: style.fontSize, unit: "PT" };
  if (style.foregroundColor) {
    const hex = style.foregroundColor.slice(1);
    result.foregroundColor = {
      color: {
        rgbColor: {
          red: parseInt(hex.slice(0, 2), 16) / 255,
          green: parseInt(hex.slice(2, 4), 16) / 255,
          blue: parseInt(hex.slice(4, 6), 16) / 255,
        },
      },
    };
  }
  return result;
}

function googleDocsTextStyleFields(style) {
  return Object.keys(style)
    .map((field) => field === "fontFamily" ? "weightedFontFamily" : field)
    .join(",");
}

function buildGoogleDocsFormattingRequests(document, formatting) {
  const paragraphs = getGoogleDocumentParagraphs(document);
  validateGoogleDocsFormatting(formatting, paragraphs.length);
  const firstIndex = paragraphs[0].startIndex;
  const lastEndIndex = paragraphs[paragraphs.length - 1].endIndex;
  if (!Number.isInteger(lastEndIndex) || lastEndIndex - 1 <= firstIndex) {
    throw new Error("The document has no writable text range to format.");
  }
  const wholeDocumentRange = { startIndex: firstIndex, endIndex: lastEndIndex - 1 };
  const requests = [];
  const addStyleRequest = (textRange, paragraphRange, textStyle, paragraphStyle) => {
    if (textStyle && Object.keys(textStyle).length) {
      if (textRange.endIndex <= textRange.startIndex) {
        throw new Error("The requested text has no writable range to format.");
      }
      requests.push({
        updateTextStyle: {
          range: textRange,
          textStyle: googleDocsTextStyle(textStyle),
          fields: googleDocsTextStyleFields(textStyle),
        },
      });
    }
    if (paragraphStyle && Object.keys(paragraphStyle).length) {
      requests.push({
        updateParagraphStyle: {
          range: paragraphRange,
          paragraphStyle,
          fields: Object.keys(paragraphStyle).join(","),
        },
      });
    }
  };

  addStyleRequest(wholeDocumentRange, wholeDocumentRange, formatting.textStyle, formatting.paragraphStyle);
  (formatting.paragraphStyles || []).forEach((item) => {
    const paragraph = paragraphs[item.paragraphIndex];
    const textRange = {
      startIndex: paragraph.startIndex,
      endIndex: Math.min(paragraph.endIndex - 1, lastEndIndex - 1),
    };
    const paragraphRange = {
      startIndex: paragraph.startIndex,
      endIndex: Math.min(paragraph.endIndex, lastEndIndex),
    };
    addStyleRequest(textRange, paragraphRange, item.textStyle, item.paragraphStyle);
  });
  if (!requests.length) throw new Error("Choose at least one formatting change.");
  return requests;
}

async function generateGoogleDocsFormatting(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  const options = message.quickOptions || [];
  const instruction = typeof message.instruction === "string" ? message.instruction.trim() : "";
  if (instruction.length > 2000) throw new Error("Formatting instructions must be 2,000 characters or fewer.");
  if (!options.length && !instruction) throw new Error("Choose a quick style or describe the formatting you want.");

  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  if (typeof document.revisionId !== "string") {
    throw new Error("Google Docs did not return a document revision. Refresh and try again.");
  }
  const paragraphs = getGoogleDocumentParagraphs(document);
  const quickFormatting = getGoogleDocsQuickFormatting(options);
  let aiFormatting = {};
  let notes = [];
  if (instruction) {
    const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
    if (!sessionToken) throw new Error("no_session");
    const sourceUrl = getGoogleSourceUrl(sender);
    const response = await fetch(`${BACKEND_URL}/api/ai/format-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": sessionToken,
      },
      body: JSON.stringify({
        paragraphs: paragraphs.map((paragraph) => paragraph.text),
        instruction,
        source_url: sourceUrl,
        source_urls: [sourceUrl],
        source_refs: [{ provider: "google", kind: "google_document", id: documentId }],
        client: "chrome",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
    if (data.error) throw new Error(data.error);
    if (!data.formatting || typeof data.formatting !== "object") {
      throw new Error("Exelidoc returned an invalid formatting preview. Your document was not changed.");
    }
    aiFormatting = data.formatting;
    notes = Array.isArray(data.notes) ? data.notes : [];
  }
  const formatting = mergeGoogleDocsFormatting(quickFormatting, aiFormatting);
  validateGoogleDocsFormatting(formatting, paragraphs.length);
  const summary = [
    `Formatting will apply to the entire document (${paragraphs.length} paragraphs).`,
    ...notes,
  ].join("\n");
  return { ok: true, formatting, revisionId: document.revisionId, summary };
}

async function applyGoogleDocsFormatting(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  if (typeof message.revisionId !== "string") {
    throw new Error("The formatting preview is invalid. Generate it again and retry.");
  }
  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  if (typeof document.revisionId !== "string") {
    throw new Error("Google Docs did not return a document revision. Refresh and try again.");
  }
  if (document.revisionId !== message.revisionId) {
    throw new Error("The document changed after the formatting preview. Generate a new preview before applying it.");
  }
  const requests = buildGoogleDocsFormattingRequests(document, message.formatting);
  const response = await fetch(`${GOOGLE_DOCS_API}/${encodeURIComponent(documentId)}:batchUpdate`, {
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
  const result = await readGoogleApiResponse(response);
  return {
    ok: true,
    formattingChanges: requests.length,
    revisionId: result.writeControl?.requiredRevisionId || document.revisionId,
  };
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
  const result = await readGoogleApiResponse(response);
  return result.writeControl?.requiredRevisionId || document.revisionId;
}

async function handleGoogleDocsAnalysis(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) throw new Error("no_session");

  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  if (typeof document.revisionId !== "string") {
    throw new Error("Google Docs did not return a document revision. Refresh and try again.");
  }
  const originalText = getDocumentPlainText(document);
  const gmailContext = await getSelectedGmailContext(message.gmailSourceRefs);
  const sourceUrl = getGoogleSourceUrl(sender);
  const response = await fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      text: originalText,
      instruction: message.instruction,
      context: gmailContext.context,
      source_url: sourceUrl,
      source_urls: [sourceUrl, ...gmailContext.sources.map((source) => source.url)],
      source_refs: [
        { provider: "google", kind: "google_document", id: documentId },
        ...gmailContext.sourceRefs,
      ],
      client: "chrome",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
  }
  if (data.error) throw new Error(data.error);

  if (typeof data.corrected !== "string") {
    throw new Error("Exelidoc returned an invalid document preview. Your document was not changed.");
  }
  const correctedText = data.corrected;
  return {
    ok: true,
    data,
    changed: correctedText !== originalText,
    correctedText,
    revisionId: document.revisionId,
  };
}

async function handleGoogleSlidesQuestion(message, sender) {
  let senderUrl;
  try {
    senderUrl = new URL(sender.url || "");
  } catch (error) {
    throw new Error("Open a Google Slides presentation and try again.");
  }
  const match = senderUrl.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/);
  if (
    senderUrl.hostname !== "docs.google.com"
    || !match
    || match[1] !== message.presentationId
  ) {
    throw new Error("The active Google Slides presentation could not be verified. Refresh and try again.");
  }
  if (typeof message.prompt !== "string" || !message.prompt.trim() || message.prompt.length > 10000) {
    throw new Error("Enter a question of 1 to 10,000 characters.");
  }
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) throw new Error("no_session");

  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const presentation = await getGooglePresentation(match[1], accessToken);
  const content = extractGooglePresentationText(presentation).slice(0, GOOGLE_SOURCE_CONTENT_LIMIT);
  if (!content.trim()) throw new Error("No readable slide text was found in this presentation.");
  const sourceUrl = getGooglePresentationUrl(match[1]);
  const response = await fetch(`${BACKEND_URL}/api/ai/generate-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      prompt: message.prompt,
      context: `Presentation: ${presentation.title || "Google Slides"}\nURL: ${sourceUrl}\nSlide text:\n${content}`,
      source_url: sourceUrl,
      source_urls: [sourceUrl],
      source_refs: [{ provider: "google", kind: "google_presentation", id: match[1] }],
      client: "chrome",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
  if (typeof data.generated !== "string") throw new Error("Exelidoc returned an invalid answer.");
  return { ok: true, answer: data.generated };
}

async function handleHistoryFollowUp(message) {
  if (
    typeof message.prompt !== "string"
    || !message.prompt.trim()
    || message.prompt.length > 10000
    || !Array.isArray(message.sourceRefs)
    || !message.sourceRefs.length
    || message.sourceRefs.length > 10
  ) {
    throw new Error("A follow-up question and saved Google sources are required.");
  }
  const sourceRefs = message.sourceRefs.filter((sourceRef) => (
    sourceRef
    && sourceRef.provider === "google"
    && [
      "gmail_message",
      "google_document",
      "google_spreadsheet",
      "google_presentation",
    ].includes(sourceRef.kind)
    && typeof sourceRef.id === "string"
    && /^[A-Za-z0-9_-]{1,256}$/.test(sourceRef.id)
  ));
  if (!sourceRefs.length) throw new Error("No supported Google source references were saved for this question.");

  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) throw new Error("no_session");
  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const sources = await Promise.all(sourceRefs.map((sourceRef) => (
    getGoogleSourceForRef(sourceRef, accessToken)
  )));
  const previousPrompt = typeof message.previousPrompt === "string"
    ? message.previousPrompt.slice(0, 10000)
    : "";
  const sourceContext = sources.map((source, index) => (
    `Source ${index + 1}\nTitle: ${source.title}\nType: ${source.type}\nURL: ${source.url}\nContent:\n${source.content}`
  )).join("\n\n---\n\n");
  const context = [
    previousPrompt ? `Earlier question: ${previousPrompt}` : "",
    sourceContext,
  ].filter(Boolean).join("\n\n").slice(0, 24000);
  const urls = sources.map((source) => source.url);
  const response = await fetch(`${BACKEND_URL}/api/ai/generate-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      prompt: message.prompt,
      context,
      source_url: urls[0],
      source_urls: urls,
      source_refs: sourceRefs,
      client: "chrome",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Exelidoc backend returned ${response.status}.`);
  if (typeof data.generated !== "string") throw new Error("Exelidoc returned an invalid answer.");
  return { ok: true, answer: data.generated };
}

async function applyGoogleDocumentEdit(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  if (typeof message.text !== "string" || typeof message.revisionId !== "string") {
    throw new Error("The document preview is invalid. Generate it again and retry.");
  }

  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  if (typeof document.revisionId !== "string") {
    throw new Error("Google Docs did not return a document revision. Refresh and try again.");
  }
  if (document.revisionId !== message.revisionId) {
    throw new Error("The document changed after the preview. Generate a new preview before applying it.");
  }

  const revisionId = await replaceGoogleDocumentText(document, message.text, accessToken);
  return { ok: true, previousText: getDocumentPlainText(document), revisionId };
}

async function restoreGoogleDocumentText(message, sender) {
  const documentId = getDocsDocumentId(message, sender);
  if (typeof message.revisionId !== "string") {
    throw new Error("The undo request is invalid. Generate a new preview before retrying.");
  }

  const accessToken = await getGoogleDocsAccessToken();
  const document = await getGoogleDocument(documentId, accessToken);
  assertPlainTextDocument(document.body?.content || []);
  if (typeof document.revisionId !== "string") {
    throw new Error("Google Docs did not return a document revision. Refresh and try again.");
  }
  if (document.revisionId !== message.revisionId) {
    throw new Error("The document changed after Exelidoc edited it. Undo was stopped to avoid overwriting newer changes.");
  }
  const revisionId = await replaceGoogleDocumentText(document, String(message.text || ""), accessToken);
  return { ok: true, revisionId };
}

function handleGoogleSheetMessage(message, sender, sendResponse, operation, label) {
  chrome.storage.local.get(["googleDataConnected"], ({ googleDataConnected }) => {
    if (!googleDataConnected) {
      sendResponse({ ok: false, error: "Connect Google access from the Exelidoc popup first." });
      return;
    }
    operation(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error(`Exelidoc background: ${label} failed`, error.message);
        sendResponse({ ok: false, error: googleAuthorizationHelp(error, "Sheets") });
      });
  });
}

async function analyzeTextWithGmailContext(message, sender) {
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  if (!sessionToken) return { ok: false, error: "no_session" };

  const gmailContext = await getSelectedGmailContext(message.gmailSourceRefs);
  const currentGmailSource = getGmailSourceRef(sender);
  const sourceRefs = [
    ...gmailContext.sourceRefs,
    ...(currentGmailSource ? [currentGmailSource] : []),
  ].filter((sourceRef, index, refs) => (
    refs.findIndex((candidate) => candidate.id === sourceRef.id) === index
  ));
  const response = await fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      text: message.text,
      instruction: message.instruction,
      context: gmailContext.context,
      source_url: getGoogleSourceUrl(sender),
      source_refs: sourceRefs,
      client: "chrome",
    }),
  });
  let data = {};
  const raw = await response.text();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      data = { error: raw };
    }
  }
  if (response.status === 401) return { ok: false, error: "invalid_session" };
  if (response.status === 402) return { ok: false, error: "subscription_inactive" };
  if (response.status === 429) return { ok: false, error: data.error || "monthly_limit_reached" };
  if (!response.ok) return { ok: false, error: data.error || "request_failed" };
  return { ok: true, data };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CONNECT_GOOGLE_DATA") {
    chrome.storage.local.get(["googleDataConnected"], ({ googleDataConnected }) => {
      getGoogleAccessToken(GOOGLE_CONNECT_SCOPES, true)
        .then(() => new Promise((resolve) => {
          chrome.storage.local.set({
            googleDataConnected: true,
            googleAccessConfigVersion: GOOGLE_ACCESS_CONFIG_VERSION,
          }, resolve);
        }))
        .then(async () => {
          if (googleDataConnected) {
            await ensureGmailIndexScanScheduled();
            scanGmailInbox().catch((error) => {
              console.error("Exelidoc Gmail: connection-triggered scan failed", error.message);
            });
          } else {
            await startGmailIndexing();
          }
        })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          console.error("Exelidoc background: Google data authorization failed", error.message);
          sendResponse({ ok: false, error: googleAuthorizationHelp(error, "Google data") });
        });
      });
    return true;
  }

  if (message.type === "DISCONNECT_GOOGLE_DATA") {
    stopGmailIndexing()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Exelidoc background: Google disconnect failed", error.message);
        sendResponse({ ok: false, error: error.message || "Could not disconnect Google access." });
      });
    return true;
  }

  if (message.type === "GET_GMAIL_SCAN_STATUS") {
    chrome.storage.local.get(
      ["googleDataConnected", "googleAccessConfigVersion", "gmailScanState"],
      (data) => {
        sendResponse({
          ok: true,
          connected: Boolean(data.googleDataConnected),
          accessConfigured: data.googleAccessConfigVersion === GOOGLE_ACCESS_CONFIG_VERSION,
          scan: data.gmailScanState || null,
        });
      }
    );
    return true;
  }

  if (message.type === "SCAN_GMAIL_NOW") {
    scanGmailInbox()
      .then(async () => sendResponse({ ok: true, scan: await getGmailScanState() }))
      .catch((error) => {
        console.error("Exelidoc background: manual Gmail scan failed", error.message);
        sendResponse({ ok: false, error: error.message || "Gmail scan failed." });
      });
    return true;
  }

  if (message.type === "SEARCH_GOOGLE_SOURCES") {
    chrome.storage.local.get(["googleDataConnected"], ({ googleDataConnected }) => {
      if (!googleDataConnected) {
        sendResponse({ ok: false, error: "Connect Google email, Docs, and Sheets first." });
        return;
      }
      searchGoogleSources(message.query)
        .then((items) => sendResponse({ ok: true, items }))
        .catch((error) => {
          console.error("Exelidoc background: Google source search failed", error.message);
          sendResponse({ ok: false, error: error.message || "Google source search failed." });
        });
    });
    return true;
  }

  if (message.type === "SEARCH_GMAIL_CONTEXT") {
    chrome.storage.local.get(["googleDataConnected"], ({ googleDataConnected }) => {
      if (!googleDataConnected) {
        sendResponse({ ok: false, error: "Connect Google once from the Exelidoc popup to search Gmail." });
        return;
      }
      searchGmailContext(message.query)
        .then((items) => sendResponse({ ok: true, items }))
        .catch((error) => {
          console.error("Exelidoc background: Gmail context search failed", error.message);
          sendResponse({ ok: false, error: googleAuthorizationHelp(error, "Gmail") });
        });
    });
    return true;
  }

  if (message.type === "READ_GOOGLE_SHEET_EDIT_RANGE") {
    handleGoogleSheetMessage(message, sender, sendResponse, readGoogleSheetEditRange, "Google Sheets read");
    return true;
  }

  if (message.type === "GET_GOOGLE_SHEET_INFO") {
    handleGoogleSheetMessage(message, sender, sendResponse, getGoogleSheetInfo, "Google Sheets metadata");
    return true;
  }

  if (message.type === "GENERATE_GOOGLE_SHEET_EDIT") {
    handleGoogleSheetMessage(message, sender, sendResponse, generateGoogleSheetEdit, "Google Sheets preview");
    return true;
  }

  if (message.type === "APPLY_GOOGLE_SHEET_EDIT") {
    handleGoogleSheetMessage(message, sender, sendResponse, applyGoogleSheetEdit, "Google Sheets apply");
    return true;
  }

  if (message.type === "GENERATE_GOOGLE_SHEET_FORMATTING") {
    handleGoogleSheetMessage(message, sender, sendResponse, generateGoogleSheetFormatting, "Google Sheets formatting preview");
    return true;
  }

  if (message.type === "APPLY_GOOGLE_SHEET_FORMATTING") {
    handleGoogleSheetMessage(message, sender, sendResponse, applyGoogleSheetFormatting, "Google Sheets formatting apply");
    return true;
  }

  if (message.type === "ANALYZE_GOOGLE_DOC") {
    handleGoogleDocsAnalysis(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Docs request failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google Docs request failed." });
      });
    return true;
  }

  if (message.type === "PREVIEW_GOOGLE_DOC_FORMATTING") {
    generateGoogleDocsFormatting(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Docs formatting preview failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google Docs formatting preview failed." });
      });
    return true;
  }

  if (message.type === "APPLY_GOOGLE_DOC_FORMATTING") {
    applyGoogleDocsFormatting(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Docs formatting apply failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google Docs formatting failed." });
      });
    return true;
  }

  if (message.type === "ANALYZE_GOOGLE_SLIDES") {
    handleGoogleSlidesQuestion(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Slides request failed", error.message);
        sendResponse({ ok: false, error: googleAuthorizationHelp(error, "Slides") });
      });
    return true;
  }

  if (message.type === "FOLLOW_UP_HISTORY") {
    handleHistoryFollowUp(message)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: history follow-up failed", error.message);
        sendResponse({ ok: false, error: error.message || "Could not answer the follow-up." });
      });
    return true;
  }

  if (message.type === "APPLY_GOOGLE_DOC_EDIT") {
    applyGoogleDocumentEdit(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Docs apply failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google Docs update failed." });
      });
    return true;
  }

  if (message.type === "RESTORE_GOOGLE_DOC") {
    restoreGoogleDocumentText(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: Google Docs undo failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google Docs restore failed." });
      });
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
    analyzeTextWithGmailContext(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("Exelidoc background: text analysis failed", error.message);
        sendResponse({ ok: false, error: error.message || "Text analysis failed." });
      });
    return true;
  }
});