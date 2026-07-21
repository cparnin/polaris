import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInterval, resolveCount } from "./config.js";

test("resolveInterval accepts sane cadences", () => {
  assert.equal(resolveInterval("60000").value, 60_000);
  assert.equal(resolveInterval("10000").value, 10_000); // exactly at the floor
  assert.equal(resolveInterval(undefined).value, 300_000);
  assert.equal(resolveInterval(undefined).warning, undefined);
});

test("resolveInterval rejects values that would make setInterval spin", () => {
  // NaN and 0 coerce to a 0ms interval: back-to-back scanning forever.
  for (const raw of ["", "abc", "NaN", "0", "-1", "5000"]) {
    const r = resolveInterval(raw);
    assert.equal(r.value, 300_000, `${raw} should fall back`);
    assert.ok(r.warning, `${raw} should warn`);
  }
});

test("resolveInterval rejects values past the timer ceiling", () => {
  // The floor alone isn't enough: an extra-zeros typo overflows the timer and
  // Node silently clamps the delay to 1ms - the same runaway, other end.
  for (const raw of ["3000000000", "2147483648", "1e999"]) {
    const r = resolveInterval(raw);
    assert.equal(r.value, 300_000, `${raw} should fall back`);
    assert.ok(r.warning);
  }
  assert.equal(resolveInterval("2147483647").value, 2_147_483_647); // still ok
});

test("resolveCount rejects values SQLite can't bind", () => {
  // The real-world trigger: `EVENT_RETENTION=5000  # keep 5k` before the .env
  // parser stripped inline comments. NaN reaches SQLite and pruneEvents throws
  // on EVERY scan, which aborts the scan before notifications ever run.
  for (const raw of ["5000  # keep 5k", "abc", "", "-1", "0", "3.7", "NaN", "Infinity"]) {
    const r = resolveCount("EVENT_RETENTION", raw, 5000);
    assert.equal(r.value, 5000, `${raw} should fall back`);
    assert.ok(r.warning, `${raw} should warn`);
  }
});

test("resolveCount passes through valid counts", () => {
  assert.equal(resolveCount("EVENT_RETENTION", "250", 5000).value, 250);
  assert.equal(resolveCount("EVENT_RETENTION", undefined, 5000).value, 5000);
  assert.equal(resolveCount("X", "5", 1, { min: 1, max: 3 }).value, 1); // over max
});
