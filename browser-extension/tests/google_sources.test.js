const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const manifest = require("../manifest.json");
const { TextDecoder } = require("node:util");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);

function createHarness({ currentSheetValues = [["Quarter", "Forecast"], ["Q1", 120]] } = {}) {
  let onMessage;
  const requests = [];
  const gmailBody = Buffer.from("Budget review email body").toString("base64url");
  const chrome = {
    runtime: {
      getManifest: () => ({ oauth2: { client_id: "test-client" } }),
      onMessage: {
        addListener(callback) {
          onMessage = callback;
        },
      },
      lastError: null,
    },
    storage: {
      local: {
        get: (_keys, callback) => {
          const value = { googleDataConnected: true, sessionToken: "test-session" };
          if (callback) callback(value);
          return Promise.resolve(value);
        },
      },
    },
    identity: {
      getAuthToken: (options, callback) => {
        const scopes = Array.from(options.scopes);
        assert.ok(
          JSON.stringify(scopes) === JSON.stringify([
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/spreadsheets.readonly",
          ])
          || JSON.stringify(scopes) === JSON.stringify([
            "https://www.googleapis.com/auth/spreadsheets",
          ])
          || JSON.stringify(scopes) === JSON.stringify([
            "https://www.googleapis.com/auth/gmail.readonly",
          ])
        );
        callback("google-token");
      },
    },
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsedUrl = new URL(url);
    const pathname = decodeURIComponent(parsedUrl.pathname);
    if (pathname.endsWith("/users/me/messages")) {
      return jsonResponse({ messages: [{ id: "message-1" }] });
    }
    if (pathname.endsWith("/users/me/messages/message-1")) {
      return jsonResponse({
        id: "message-1",
        labelIds: ["INBOX", "CATEGORY_PERSONAL"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "Budget review" },
            { name: "From", value: "person@example.com" },
            { name: "Date", value: "Mon, 1 Jan 2026 12:00:00 +0000" },
          ],
          body: { data: gmailBody },
        },
      });
    }
    if (pathname.endsWith("/drive/v3/files")) {
      return jsonResponse({
        files: [
          {
            id: "doc-1",
            name: "Budget notes",
            mimeType: "application/vnd.google-apps.document",
            webViewLink: "https://docs.google.com/document/d/doc-1/edit",
          },
          {
            id: "sheet-1",
            name: "Forecast",
            mimeType: "application/vnd.google-apps.spreadsheet",
            webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
          },
          {
            id: "slide-1",
            name: "Budget presentation",
            mimeType: "application/vnd.google-apps.presentation",
            webViewLink: "https://docs.google.com/presentation/d/slide-1/edit",
          },
        ],
      });
    }
    if (pathname.endsWith("/documents/doc-1")) {
      return jsonResponse({
        documentId: "doc-1",
        body: {
          content: [{
            paragraph: {
              elements: [{ textRun: { content: "Budget document details\n" } }],
            },
          }],
        },
      });
    }
    if (pathname.endsWith("/presentations/slide-1")) {
      return jsonResponse({
        title: "Budget presentation",
        slides: [{
          pageElements: [{
            shape: {
              text: {
                textElements: [{ textRun: { content: "Slide summary" } }],
              },
            },
          }],
        }],
      });
    }
    if (pathname.endsWith("/spreadsheets/sheet-1")) {
      return jsonResponse({
        properties: { title: "Forecast" },
        sheets: [{ properties: { title: "Plan", sheetId: 123 } }],
      });
    }
    if (pathname.endsWith("/spreadsheets/sheet-1/values/'Plan'!A1:Z100")) {
      return jsonResponse({ values: currentSheetValues });
    }
    if (pathname.endsWith("/spreadsheets/sheet-1/values/'Plan'!A1:B2")) {
      return jsonResponse({ values: currentSheetValues });
    }
    if (pathname.endsWith("/spreadsheets/sheet-1:batchUpdate")) {
      return jsonResponse({ spreadsheetId: "sheet-1" });
    }
    if (url.endsWith("/api/ai/generate-text")) {
      return jsonResponse({ generated: "This presentation is about the budget." });
    }
    if (url.endsWith("/api/ai/analyze-text")) {
      return jsonResponse({ corrected: "Draft based on the selected email." });
    }
    if (url.endsWith("/api/ai/edit-range")) {
      return jsonResponse({ correctedValues: [["Name", "New"]], notes: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch,
    URL,
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    console: { info() {}, warn() {}, error() {} },
    encodeURIComponent,
    JSON,
    Promise,
    Error,
    String,
    Array,
    Number,
  });

  return {
    requests,
    send(message, sender = {}) {
      return new Promise((resolve) => {
        assert.equal(onMessage(message, sender, resolve), true);
      });
    },
  };
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test("on-demand Google search reads email, Docs, and Sheets without storing tokens", async () => {
  const harness = createHarness();
  const response = await harness.send({
    type: "SEARCH_GOOGLE_SOURCES",
    query: "budget forecast",
  });

  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.items, (item) => item.type), [
    "email",
    "document",
    "spreadsheet",
    "presentation",
  ]);
  assert.match(response.items[0].content, /Budget review email body/);
  assert.match(response.items[1].content, /Budget document details/);
  assert.match(response.items[2].content, /Q1\t120/);
  assert.match(response.items[3].content, /Slide summary/);
  assert.equal(JSON.stringify(response.items[0].sourceRef), JSON.stringify({
    provider: "google",
    kind: "gmail_message",
    id: "message-1",
  }));
  assert.equal(JSON.stringify(response.items[3].sourceRef), JSON.stringify({
    provider: "google",
    kind: "google_presentation",
    id: "slide-1",
  }));
  assert.deepEqual(Array.from(response.items[2].sheetTitles), ["Plan"]);
  assert.ok(harness.requests.every(({ options }) => (
    options.headers.Authorization === "Bearer google-token"
  )));
  assert.ok(harness.requests.every(({ url }) => !url.includes("api-key")));
});

test("Google Slides questions send text only after an explicit request and retain source IDs", async () => {
  const harness = createHarness();
  const response = await harness.send({
    type: "ANALYZE_GOOGLE_SLIDES",
    presentationId: "slide-1",
    prompt: "What is the presentation about?",
  }, {
    url: "https://docs.google.com/presentation/d/slide-1/edit",
  });

  assert.equal(response.ok, true);
  assert.match(response.answer, /budget/);
  const request = harness.requests.find(({ url }) => url.endsWith("/api/ai/generate-text"));
  const body = JSON.parse(request.options.body);
  assert.match(body.context, /Slide summary/);
  assert.deepEqual(body.source_refs, [{
    provider: "google",
    kind: "google_presentation",
    id: "slide-1",
  }]);
});

test("history follow-up re-fetches source content only after the user asks", async () => {
  const harness = createHarness();
  const response = await harness.send({
    type: "FOLLOW_UP_HISTORY",
    prompt: "What was the email asking for?",
    previousPrompt: "Summarize this email",
    sourceRefs: [{ provider: "google", kind: "gmail_message", id: "message-1" }],
  });

  assert.equal(response.ok, true);
  const request = harness.requests.find(({ url }) => url.endsWith("/api/ai/generate-text"));
  const body = JSON.parse(request.options.body);
  assert.match(body.context, /Budget review email body/);
  assert.match(body.context, /Earlier question: Summarize this email/);
  assert.deepEqual(body.source_refs, [{
    provider: "google",
    kind: "gmail_message",
    id: "message-1",
  }]);
});

test("Gmail source search returns selectable email references", async () => {
  const harness = createHarness();
  const response = await harness.send({
    type: "SEARCH_GMAIL_CONTEXT",
    query: "budget report",
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].title, "Budget review");
  assert.equal(response.items[0].sourceRef.id, "message-1");
  assert.equal(response.items[0].location, "Inbox");
});

test("Gmail draft analysis includes only explicitly selected email content", async () => {
  const harness = createHarness();
  const response = await harness.send({
    type: "ANALYZE_TEXT",
    text: "Hello",
    instruction: "Write a reply using this email",
    gmailSourceRefs: [{
      provider: "google",
      kind: "gmail_message",
      id: "message-1",
    }],
  }, {
    url: "https://mail.google.com/mail/u/0/#inbox",
  });

  assert.equal(response.ok, true, response.error);
  const request = harness.requests.find(({ url }) => url.endsWith("/api/ai/analyze-text"));
  const body = JSON.parse(request.options.body);
  assert.match(body.context, /Budget review email body/);
  assert.deepEqual(body.source_refs, [
    { provider: "google", kind: "gmail_message", id: "message-1" },
  ]);
});

test("Google Sheets preview includes only the selected Gmail messages as context", async () => {
  const harness = createHarness();
  const response = await harness.send({
    type: "GENERATE_GOOGLE_SHEET_EDIT",
    snapshot: {
      spreadsheetId: "sheet-1",
      sheetTitle: "Plan",
      range: "A1:B2",
      values: [["Quarter", "Forecast"], ["Q1", 120]],
    },
    instruction: "Create a forecast based on these emails",
    gmailSourceRefs: [{
      provider: "google",
      kind: "gmail_message",
      id: "message-1",
    }],
  }, {
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
  });

  assert.equal(response.ok, true, response.error);
  const request = harness.requests.find(({ url }) => url.endsWith("/api/ai/edit-range"));
  const body = JSON.parse(request.options.body);
  assert.match(body.context, /Budget review email body/);
  assert.deepEqual(body.source_refs, [
    { provider: "google", kind: "google_spreadsheet", id: "sheet-1" },
    { provider: "google", kind: "gmail_message", id: "message-1" },
  ]);
});

test("manifest schedules Gmail indexing and injects Exelidoc in Sheets and Slides", () => {
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.content_scripts.some(({ matches, js }) => (
    matches.includes("https://docs.google.com/presentation/*")
    && js.includes("content-scripts/slides.js")
  )));
  assert.ok(manifest.content_scripts.some(({ matches, js }) => (
    matches.includes("https://docs.google.com/spreadsheets/*")
    && js.includes("content-scripts/gsheets.js")
  )));
  assert.ok(manifest.content_scripts.some(({ matches, js }) => (
    matches.includes("https://docs.google.com/document/*")
    && js.includes("content-scripts/gmail-source-picker.js")
    && js.indexOf("content-scripts/gmail-source-picker.js")
      < js.indexOf("content-scripts/gdocs.js")
  )));
  assert.ok(manifest.oauth2.scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(manifest.oauth2.scopes.includes("https://www.googleapis.com/auth/documents"));
  assert.ok(manifest.oauth2.scopes.includes("https://www.googleapis.com/auth/spreadsheets"));
  assert.equal(manifest.oauth2.scopes.includes("https://www.googleapis.com/auth/presentations.readonly"), false);
  assert.ok(manifest.content_scripts.some(({ matches, js }) => (
    matches.includes("https://docs.google.com/document/*")
    && js.includes("content-scripts/gmail-source-picker.js")
  )));
  assert.ok(manifest.content_scripts.some(({ matches, js }) => (
    matches.includes("https://mail.google.com/*")
    && js.includes("content-scripts/gmail-source-picker.js")
  )));
  assert.ok(manifest.content_scripts.some(({ matches, js }) => (
    matches.includes("https://docs.google.com/spreadsheets/*")
    && js.includes("content-scripts/gmail-source-picker.js")
  )));
});

test("Google Sheets edits recheck source values and formulas need separate confirmation", async () => {
  const harness = createHarness({
    currentSheetValues: [["Name", "=SUM(B1:B2)"], ["Old", 12]],
  });
  const loaded = await harness.send({
    type: "READ_GOOGLE_SHEET_EDIT_RANGE",
    spreadsheetId: "sheet-1",
    sheetTitle: "Plan",
    range: "A1:B2",
  });
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(Array.from(loaded.snapshot.values[0]), ["Name", "=SUM(B1:B2)"]);

  const changedFormula = await harness.send({
    type: "APPLY_GOOGLE_SHEET_EDIT",
    snapshot: loaded.snapshot,
    correctedValues: [["Name", "=SUM(B1:B3)"], ["New", 12]],
    confirmFormulaChanges: false,
  });
  assert.equal(changedFormula.ok, false);
  assert.match(changedFormula.error, /confirm/i);
  assert.equal(
    harness.requests.some(({ url }) => url.includes(":batchUpdate")),
    false
  );

  const applied = await harness.send({
    type: "APPLY_GOOGLE_SHEET_EDIT",
    snapshot: loaded.snapshot,
    correctedValues: [["Name", "=SUM(B1:B3)"], ["New", 12]],
    confirmFormulaChanges: true,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.updatedCells, 2);
  assert.equal(applied.formulaChanges, 1);
  const write = harness.requests.find(({ url }) => url.includes(":batchUpdate"));
  const updates = JSON.parse(write.options.body).requests.map((item) => item.updateCells);
  assert.ok(updates.every((request) => request.range.sheetId === 123));
  assert.ok(updates.some((request) => (
    request.rows[0].values[0].userEnteredValue.stringValue === "New"
  )));
  assert.ok(updates.some((request) => (
    request.rows[0].values[0].userEnteredValue.formulaValue === "=SUM(B1:B3)"
  )));
});

test("Google Sheets apply stops when the range changed after preview", async () => {
  const harness = createHarness({
    currentSheetValues: [["Current", "=SUM(B1:B2)"], ["Old", 12]],
  });

  test("Google Sheets page can load sheet tabs and generate an edit preview", async () => {
    const harness = createHarness();
    const sender = { url: "https://docs.google.com/spreadsheets/d/sheet-1/edit" };
    const info = await harness.send({
      type: "GET_GOOGLE_SHEET_INFO",
      spreadsheetId: "sheet-1",
    }, sender);
    assert.equal(info.ok, true);
    assert.equal(info.title, "Forecast");
    assert.deepEqual(Array.from(info.sheets, (sheet) => sheet.title), ["Plan"]);

    const result = await harness.send({
      type: "GENERATE_GOOGLE_SHEET_EDIT",
      snapshot: {
        spreadsheetId: "sheet-1",
        sheetTitle: "Plan",
        range: "A1:B1",
        values: [["Name", "Old"]],
      },
      instruction: "Change Old to New",
    }, sender);
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(result.data.correctedValues[0]), ["Name", "New"]);
    const request = harness.requests.find(({ url }) => url.endsWith("/api/ai/edit-range"));
    const body = JSON.parse(request.options.body);
    assert.deepEqual(body.source_refs, [{
      provider: "google",
      kind: "google_spreadsheet",
      id: "sheet-1",
    }]);
  });

  test("Google Sheets page messages cannot target a different spreadsheet", async () => {
    const harness = createHarness();
    const response = await harness.send({
      type: "GET_GOOGLE_SHEET_INFO",
      spreadsheetId: "sheet-1",
    }, {
      url: "https://docs.google.com/spreadsheets/d/other-sheet/edit",
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /could not be verified/i);
    assert.equal(harness.requests.length, 0);
  });
  const loaded = await harness.send({
    type: "READ_GOOGLE_SHEET_EDIT_RANGE",
    spreadsheetId: "sheet-1",
    sheetTitle: "Plan",
    range: "A1:B2",
  });
  assert.equal(loaded.ok, true, loaded.error);

  const changed = await harness.send({
    type: "APPLY_GOOGLE_SHEET_EDIT",
    snapshot: {
      ...loaded.snapshot,
      values: [["Old", "=SUM(B1:B2)"], ["Old", 12]],
    },
    correctedValues: [["New", "=SUM(B1:B2)"], ["Old", 12]],
  });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /changed after the preview/i);
  assert.equal(
    harness.requests.some(({ url }) => url.includes(":batchUpdate")),
    false
  );
});
