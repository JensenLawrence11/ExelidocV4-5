// Service worker: remembers the signed-in user with a session token, not a raw API key.

const BACKEND_URL = "https://exelidocv4-5.onrender.com";
const GOOGLE_DOCS_API = "https://docs.googleapis.com/v1/documents";
const GOOGLE_DATA_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];
const GOOGLE_SHEETS_EDIT_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SOURCE_LIMIT = 4;
const GOOGLE_SOURCE_CONTENT_LIMIT = 6000;
const GOOGLE_SHEET_EDIT_MAX_CELLS = 2500;

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
    ["https://www.googleapis.com/auth/documents"],
    true
  );
}

async function readGoogleApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Google API returned ${response.status}.`;
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

function getGmailBody(payload) {
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
    .slice(0, GOOGLE_SOURCE_CONTENT_LIMIT);
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
    const message = await googleApiRequest(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
      accessToken
    );
    const headers = message.payload?.headers || [];
    const subject = getHeader(headers, "subject") || "(no subject)";
    const from = getHeader(headers, "from");
    const to = getHeader(headers, "to");
    const date = getHeader(headers, "date");
    const body = getGmailBody(message.payload) || message.snippet || "";
    return {
      type: "email",
      title: subject,
      url: `https://mail.google.com/mail/#all/${encodeURIComponent(message.id)}`,
      content: [
        `From: ${from}`,
        `To: ${to}`,
        `Date: ${date}`,
        `Subject: ${subject}`,
        "",
        body,
      ].filter(Boolean).join("\n").slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
    };
  }));
  return messages;
}

async function getGoogleDocSource(file, accessToken) {
  const document = await getGoogleDocument(file.id, accessToken);
  return {
    type: "document",
    title: file.name,
    url: file.webViewLink || `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/edit`,
    content: getDocumentPlainText(document).slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
  };
}

async function getGooglePresentationSource(file, accessToken) {
  const presentation = await googleApiRequest(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(file.id)}?fields=title,slides(pageElements(shape(text(textElements(textRun(content)))),table(tableRows(tableCells(text(textElements(textRun(content))))))))`,
    accessToken
  );
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
  return {
    type: "presentation",
    title: file.name || presentation.title || "Google Slides",
    url: file.webViewLink || `https://docs.google.com/presentation/d/${encodeURIComponent(file.id)}/edit`,
    content: textRuns.join("").slice(0, GOOGLE_SOURCE_CONTENT_LIMIT),
  };
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
  };
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
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties(title),sheets(properties(sheetId,title))`,
    accessToken
  );
}

async function readGoogleSheetEditRange(message) {
  const accessToken = await getGoogleAccessToken(GOOGLE_DATA_SCOPES, false);
  const metadata = await getGoogleSheetMetadata(message.spreadsheetId, accessToken);
  const titles = (metadata.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  if (typeof message.sheetTitle !== "string" || !titles.includes(message.sheetTitle)) {
    throw new Error("The selected sheet tab could not be verified. Search again and retry.");
  }
  const dimensions = parseGoogleSheetRange(message.range);
  const { qualifiedRange, url } = getGoogleSheetRangeUrl(
    message.spreadsheetId,
    message.sheetTitle,
    message.range.trim().toUpperCase()
  );
  const data = await googleApiRequest(url, accessToken);
  return {
    snapshot: {
      spreadsheetId: message.spreadsheetId,
      sheetTitle: message.sheetTitle,
      range: message.range.trim().toUpperCase(),
      qualifiedRange,
      dimensions,
      values: normalizeGoogleSheetValues(data.values || [], dimensions.rowCount, dimensions.columnCount),
    },
  };
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

async function applyGoogleSheetEdit(message) {
  const snapshot = message.snapshot;
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
  const [emails, files] = await Promise.all([
    getGmailSearchResults(query.trim(), accessToken),
    getGoogleDriveSearchResults(query.trim(), accessToken),
  ]);
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
  const response = await fetch(`${BACKEND_URL}/api/ai/analyze-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      text: originalText,
      instruction: message.instruction,
      source_url: getGoogleSourceUrl(sender),
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

function handleGoogleSheetMessage(message, sendResponse, operation, label) {
  chrome.storage.local.get(["googleDataConnected"], ({ googleDataConnected }) => {
    if (!googleDataConnected) {
      sendResponse({ ok: false, error: "Connect Google email, Docs, and Sheets first." });
      return;
    }
    operation(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error(`Exelidoc background: ${label} failed`, error.message);
        sendResponse({ ok: false, error: error.message || `${label} failed.` });
      });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CONNECT_GOOGLE_DATA") {
    getGoogleAccessToken(GOOGLE_DATA_SCOPES, true)
      .then(() => new Promise((resolve) => {
        chrome.storage.local.set({ googleDataConnected: true }, resolve);
      }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Exelidoc background: Google data authorization failed", error.message);
        sendResponse({ ok: false, error: error.message || "Google authorization failed." });
      });
    return true;
  }

  if (message.type === "DISCONNECT_GOOGLE_DATA") {
    chrome.identity.clearAllCachedAuthTokens(() => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      chrome.storage.local.remove(["googleDataConnected"], () => sendResponse({ ok: true }));
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

  if (message.type === "READ_GOOGLE_SHEET_EDIT_RANGE") {
    handleGoogleSheetMessage(message, sendResponse, readGoogleSheetEditRange, "Google Sheets read");
    return true;
  }

  if (message.type === "APPLY_GOOGLE_SHEET_EDIT") {
    handleGoogleSheetMessage(message, sendResponse, applyGoogleSheetEdit, "Google Sheets apply");
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
          source_url: getGoogleSourceUrl(sender),
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