import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each node:test file runs in its own process, so pointing POLARIS_DATA_DIR at
// a temp dir before importing gives this file a clean database.
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "polaris-outbox-"));
const { queueAlert, readOutbox, drainOutbox } = await import("./outbox.js");
const { setMeta } = await import("./db.js");

const msg = (title: string) => ({ title, message: "body" });

beforeEach(() => setMeta("alertOutbox", "[]"));

test("a queued alert survives and drains on a successful send", async () => {
  queueAlert(msg("lost push"));
  assert.equal(readOutbox().length, 1);
  assert.equal(readOutbox()[0].attempts, 1);

  await drainOutbox(async () => true);
  assert.equal(readOutbox().length, 0);
});

test("a failed drain keeps the alert and counts the attempt", async () => {
  queueAlert(msg("still failing"));
  await drainOutbox(async () => false);
  const items = readOutbox();
  assert.equal(items.length, 1);
  assert.equal(items[0].attempts, 2);
});

test("an alert is dropped after exhausting its attempts", async () => {
  queueAlert(msg("doomed")); // attempts: 1
  for (let i = 0; i < 4; i++) await drainOutbox(async () => false);
  assert.equal(readOutbox().length, 0, "5th total attempt should drop it");
});

test("the queue is capped so a dead topic can't hoard alerts forever", () => {
  for (let i = 0; i < 30; i++) queueAlert(msg(`alert ${i}`));
  const items = readOutbox();
  assert.equal(items.length, 20);
  // oldest fell off, newest kept
  assert.equal(items[items.length - 1].msg.title, "alert 29");
  assert.equal(items[0].msg.title, "alert 10");
});

test("corrupt meta JSON reads as an empty queue instead of throwing", () => {
  setMeta("alertOutbox", "{not json");
  assert.deepEqual(readOutbox(), []);
});
