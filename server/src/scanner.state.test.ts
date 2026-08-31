import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pause and guest mode must survive a restart: the daemon runs under launchd
 * with KeepAlive, so a crash or `./polaris restart` respawns it silently. Seed
 * the meta table BEFORE importing the scanner to prove the restore path, then
 * flip both to prove the persist path.
 */
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "polaris-state-"));
const { setMeta, getMeta } = await import("./db.js");

const futureDeadline = Date.now() + 3_600_000;
setMeta("paused", "1");
setMeta("guestUntil", String(futureDeadline));

const { isPaused, setPaused, guestModeRemaining, setGuestMode } = await import("./scanner.js");

test("paused state is restored from the DB at startup", () => {
  assert.equal(isPaused(), true);
});

test("guest mode deadline is restored from the DB at startup", () => {
  const left = guestModeRemaining();
  assert.ok(left > 0 && left <= 3_600_000, `expected time left, got ${left}`);
});

test("setPaused persists to the DB", () => {
  setPaused(false);
  assert.equal(getMeta("paused"), "0");
  setPaused(true);
  assert.equal(getMeta("paused"), "1");
});

test("setGuestMode persists the deadline, and 0 clears it", () => {
  setGuestMode(2);
  const stored = Number(getMeta("guestUntil"));
  assert.ok(stored > Date.now(), "deadline should be in the future");
  setGuestMode(0);
  assert.equal(getMeta("guestUntil"), "0");
});
