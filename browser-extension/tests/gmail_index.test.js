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

function createIndexedDb() {
  const databases = new Map();
  return {
    databases,
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let records = databases.get(name);
        const isNew = !records;
        if (!records) {
          records = new Map();
          databases.set(name, records);
        }
        const database = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            const transaction = {
              objectStore() {
                return {
                  put(record) { records.set(record.id, record); },
                  delete(id) { records.delete(id); },
                  getAll() {
                    const result = {};
                    queueMicrotask(() => {
                      result.result = Array.from(records.values());
                      result.onsuccess?.();
                    });
                    return result;
                  },
                  count() {
                    const result = {};
                    queueMicrotask(() => {
                      result.result = records.size;
                      result.onsuccess?.();
                    });
                    return result;
                  },
                };
              },
            };
            queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
          },
          close() {},
        };
        request.result = database;
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name) {
      const request = {};
      queueMicrotask(() => {
        databases.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function createHarness({ paginate = false } = {}) {
  let onMessage;
  let onStartup;
  let onAlarm;
  const data = { googleDataConnected: true };
  const alarms = [];
  const requests = [];
  const indexedDB = createIndexedDb();
  const messageBody = Buffer.from("The requested budget report is attached.").toString("base64url");
  const chrome = {
    runtime: {
      getManifest: () => ({ oauth2: { client_id: "test-client" } }),
      onMessage: { addListener(callback) { onMessage = callback; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener(callback) { onStartup = callback; } },
      lastError: null,
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          const requested = Array.isArray(keys) ? keys : [keys];
          requested.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
          });
          if (callback) {
            callback(result);
            return;
          }
          return Promise.resolve(result);
        },
        set(values, callback) {
          Object.assign(data, values);
          callback?.();
          return Promise.resolve();
        },
        remove(keys, callback) {
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete data[key]);
          callback?.();
          return Promise.resolve();
        },
      },
    },
    identity: {
      getAuthToken: (_options, callback) => callback("google-token"),
      clearAllCachedAuthTokens(callback) { callback(); },
    },
    alarms: {
      onAlarm: { addListener(callback) { onAlarm = callback; } },
      create(name, options) { alarms.push({ name, options }); },
      get: async (name) => alarms.find((alarm) => alarm.name === name) || null,
      clear: async (name) => {
        const index = alarms.findIndex((alarm) => alarm.name === name);
        if (index >= 0) alarms.splice(index, 1);
        return index >= 0;
      },
    },
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    if (pathname.endsWith("/users/me/profile")) return jsonResponse({ historyId: "100" });
    if (pathname.endsWith("/users/me/messages") && !parsedUrl.searchParams.has("format")) {
      if (paginate && parsedUrl.searchParams.get("pageToken") === "next") {
        return jsonResponse({ messages: [{ id: "message-2" }] });
      }
      return jsonResponse({
        messages: [{ id: "message-1" }],
        ...(paginate ? { nextPageToken: "next" } : {}),
      });
    }
    if (
      pathname.endsWith("/users/me/messages/message-1")
      || pathname.endsWith("/users/me/messages/message-2")
    ) {
      const messageId = pathname.endsWith("message-2") ? "message-2" : "message-1";
      return jsonResponse({
        id: messageId,
        threadId: "thread-1",
        internalDate: "1767225600000",
        labelIds: ["INBOX"],
        snippet: "Budget report attached",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "Budget report" },
            { name: "From", value: "person@example.com" },
            { name: "Date", value: "Thu, 1 Jan 2026 00:00:00 +0000" },
          ],
          body: { data: messageBody },
        },
      });
    }
    if (pathname.endsWith("/users/me/history")) {
      return jsonResponse({ historyId: "100", history: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch,
    indexedDB,
    URL,
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    queueMicrotask,
    console: { info() {}, warn() {}, error() {} },
    encodeURIComponent,
    JSON,
    Promise,
    Error,
    String,
    Array,
    Number,
    Set,
  });

  return {
    data,
    alarms,
    requests,
    indexedDB,
    async send(message) {
      return new Promise((resolve) => {
        assert.equal(onMessage(message, {}, resolve), true);
      });
    },
    async startup() {
      onStartup();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    triggerAlarm(name) {
      onAlarm({ name });
    },
  };
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

test("inbox scan indexes message text locally and never calls the AI backend", async () => {
  const harness = createHarness();
  const result = await harness.send({ type: "SCAN_GMAIL_NOW" });

  assert.equal(result.ok, true);
  assert.equal(result.scan.status, "ready");
  assert.equal(result.scan.indexedCount, 1);
  const database = harness.indexedDB.databases.get("exelidoc-gmail-index");
  const indexedMessage = Array.from(database.values())[0];
  assert.match(indexedMessage.body, /budget report is attached/i);
  assert.equal(harness.requests.some(({ url }) => url.includes("onrender.com")), false);
});

test("initial inbox scan paginates before marking the index ready", async () => {
  const harness = createHarness({ paginate: true });
  const firstPage = await harness.send({ type: "SCAN_GMAIL_NOW" });
  assert.equal(firstPage.scan.status, "scanning");
  assert.equal(firstPage.scan.indexedCount, 1);

  const secondPage = await harness.send({ type: "SCAN_GMAIL_NOW" });
  assert.equal(secondPage.scan.status, "ready");
  assert.equal(secondPage.scan.indexedCount, 2);
  assert.equal(
    harness.indexedDB.databases.get("exelidoc-gmail-index").size,
    2
  );
});

test("scheduled alarm is restored after startup and disconnect deletes local index", async () => {
  const harness = createHarness();
  await harness.startup();
  assert.equal(harness.alarms.length, 1);
  assert.equal(harness.alarms[0].options.periodInMinutes, 15);

  await harness.send({ type: "SCAN_GMAIL_NOW" });
  assert.ok(harness.indexedDB.databases.has("exelidoc-gmail-index"));

  const disconnected = await harness.send({ type: "DISCONNECT_GOOGLE_DATA" });
  assert.equal(disconnected.ok, true);
  assert.equal(harness.indexedDB.databases.has("exelidoc-gmail-index"), false);
  assert.equal(harness.data.googleDataConnected, undefined);
  assert.equal(harness.alarms.length, 0);
});
