const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextDecoder } = require("node:util");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);
const sender = { url: "https://docs.google.com/document/d/doc-1/edit" };

function documentSnapshot(revisionId, text = "Original text\n") {
  return {
    documentId: "doc-1",
    revisionId,
    body: {
      content: [
        {
          endIndex: text.length + 1,
          paragraph: {
            elements: [{ textRun: { content: text } }],
          },
        },
      ],
    },
  };
}

function createHarness({ documents, backendStatus = 200, backendData } = {}) {
  let onMessage;
  const requests = [];
  const snapshots = [...(documents || [documentSnapshot("rev-1")])];
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
    storage: { local: { get: async () => ({ sessionToken: "test-session" }) } },
    identity: { getAuthToken: (_options, callback) => callback("google-token") },
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.startsWith("https://gmail.googleapis.com/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "message-1",
          labelIds: ["INBOX", "CATEGORY_PERSONAL"],
          payload: {
            headers: [
              { name: "Subject", value: "Budget update" },
              { name: "From", value: "person@example.com" },
              { name: "Date", value: "Mon, 1 Jan 2026 12:00:00 +0000" },
            ],
            mimeType: "text/plain",
            body: {
              data: Buffer.from("The budget is approved.").toString("base64url"),
            },
          },
        }),
      };
    }
    if (url.includes(":batchUpdate")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ writeControl: { requiredRevisionId: "rev-2" } }),
      };
    }
    if (url.startsWith("https://docs.googleapis.com/")) {
      const document = snapshots.shift();
      return {
        ok: Boolean(document),
        status: document ? 200 : 404,
        json: async () => document || { error: { message: "No document snapshot" } },
      };
    }
    if (url.endsWith("/api/ai/analyze-text")) {
      return {
        ok: backendStatus < 400,
        status: backendStatus,
        json: async () => backendData || { corrected: "Revised text", suggestions: [] },
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch,
    URL,
    console: { info() {}, warn() {}, error() {} },
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    encodeURIComponent,
    JSON,
    Promise,
    Error,
    String,
    Array,
    Number,
    TextDecoder,
    Uint8Array,
  });

  function send(message) {
    return new Promise((resolve) => {
      assert.equal(onMessage(message, sender, resolve), true);
    });
  }

  return { requests, send };
}

test("analysis returns a preview without writing to Google Docs", async () => {
  const harness = createHarness({
    documents: [documentSnapshot("rev-1", "\n  Original text  \n\n")],
  });
  const result = await harness.send({
    type: "ANALYZE_GOOGLE_DOC",
    documentId: "doc-1",
    instruction: "Rewrite this",
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.correctedText, "Revised text");
  assert.equal(result.revisionId, "rev-1");
  const analysis = harness.requests.find(({ url }) => url.endsWith("/api/ai/analyze-text"));
  assert.equal(JSON.parse(analysis.options.body).text, "\n  Original text  \n");
  assert.equal(
    JSON.parse(analysis.options.body).source_url,
    "https://docs.google.com/document/d/doc-1/edit"
  );
  assert.deepEqual(JSON.parse(analysis.options.body).source_refs, [
    { provider: "google", kind: "google_document", id: "doc-1" },
  ]);
  assert.deepEqual(JSON.parse(analysis.options.body).source_urls, [
    "https://docs.google.com/document/d/doc-1/edit",
  ]);
  assert.equal("history_ids" in JSON.parse(analysis.options.body), false);
  assert.equal(harness.requests.some(({ url }) => url.includes(":batchUpdate")), false);
});

test("Docs analysis includes only selected Gmail context and source references", async () => {
  const harness = createHarness({
    documents: [documentSnapshot("rev-1", "Original document\n")],
  });
  const result = await harness.send({
    type: "ANALYZE_GOOGLE_DOC",
    documentId: "doc-1",
    instruction: "Use the email to update this",
    gmailSourceRefs: [{
      provider: "google",
      kind: "gmail_message",
      id: "message-1",
    }],
  });

  assert.equal(result.ok, true, result.error);
  const analysis = harness.requests.find(({ url }) => url.endsWith("/api/ai/analyze-text"));
  const body = JSON.parse(analysis.options.body);
  assert.match(body.context, /The budget is approved/);
  assert.deepEqual(body.source_refs, [
    { provider: "google", kind: "google_document", id: "doc-1" },
    { provider: "google", kind: "gmail_message", id: "message-1" },
  ]);
  assert.deepEqual(body.source_urls, [
    "https://docs.google.com/document/d/doc-1/edit",
    "https://mail.google.com/mail/#all/message-1",
  ]);
});

test("apply requires the preview revision and writes with a revision guard", async () => {
  const harness = createHarness({
    documents: [documentSnapshot("rev-1", "Original text\n")],
  });
  const result = await harness.send({
    type: "APPLY_GOOGLE_DOC_EDIT",
    documentId: "doc-1",
    text: "Revised text",
    revisionId: "rev-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.previousText, "Original text");
  assert.equal(result.revisionId, "rev-2");
  const write = harness.requests.find(({ url }) => url.includes(":batchUpdate"));
  assert.ok(write);
  assert.equal(JSON.parse(write.options.body).writeControl.requiredRevisionId, "rev-1");
});

test("apply stops when the document changed after preview generation", async () => {
  const harness = createHarness({
    documents: [documentSnapshot("rev-2", "Newer text\n")],
  });
  const result = await harness.send({
    type: "APPLY_GOOGLE_DOC_EDIT",
    documentId: "doc-1",
    text: "Stale replacement",
    revisionId: "rev-1",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /document changed after the preview/i);
  assert.equal(harness.requests.some(({ url }) => url.includes(":batchUpdate")), false);
});

test("backend errors do not produce a document write", async () => {
  const harness = createHarness({
    backendStatus: 502,
    backendData: { error: "AI provider is unavailable" },
  });
  const result = await harness.send({
    type: "ANALYZE_GOOGLE_DOC",
    documentId: "doc-1",
    instruction: "Rewrite this",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /AI provider is unavailable/);
  assert.equal(harness.requests.some(({ url }) => url.includes(":batchUpdate")), false);
});
