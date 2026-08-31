import { test } from "node:test";
import assert from "node:assert/strict";

// NTFY_URL is read at module load, so set it before importing. The URL never
// gets contacted: fetch is stubbed per test.
process.env.NTFY_URL = "https://ntfy.example/topic";
const { sendNtfy, ntfyStatus } = await import("./notify.js");

test("send outcome starts unknown, not asserted", () => {
  const s = ntfyStatus();
  assert.equal(s.configured, true);
  assert.equal(s.lastSendOk, null);
  assert.equal(s.lastSendError, null);
});

test("a rejected push records failure with the reason", async () => {
  globalThis.fetch = (async () =>
    ({ ok: false, status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
  assert.equal(await sendNtfy({ title: "t", message: "m" }), false);
  const s = ntfyStatus();
  assert.equal(s.lastSendOk, false);
  assert.equal(s.lastSendError, "404 Not Found");
  assert.ok(s.lastSendAt !== null);
});

test("a network error records failure too", async () => {
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND ntfy.example");
  }) as unknown as typeof fetch;
  assert.equal(await sendNtfy({ title: "t", message: "m" }), false);
  assert.match(ntfyStatus().lastSendError ?? "", /ENOTFOUND/);
});

test("a successful push clears the failure", async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, statusText: "OK" })) as unknown as typeof fetch;
  assert.equal(await sendNtfy({ title: "t", message: "m" }), true);
  const s = ntfyStatus();
  assert.equal(s.lastSendOk, true);
  assert.equal(s.lastSendError, null);
});
