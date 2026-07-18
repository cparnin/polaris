import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMac, formatMac, isRandomizedMac, lookupVendor } from "./vendors.js";

test("normalizeMac accepts colon, dash and dot notations", () => {
  assert.equal(normalizeMac("aa:bb:cc:dd:ee:ff"), "AABBCCDDEEFF");
  assert.equal(normalizeMac("AA-BB-CC-DD-EE-FF"), "AABBCCDDEEFF");
  assert.equal(normalizeMac("aabb.ccdd.eeff"), "AABBCCDDEEFF");
});

test("normalizeMac rejects malformed input", () => {
  assert.equal(normalizeMac("aa:bb:cc"), null); // too short
  assert.equal(normalizeMac("not-a-mac"), null);
  assert.equal(normalizeMac(""), null);
});

test("formatMac renders colon notation lowercase", () => {
  assert.equal(formatMac("AABBCCDDEEFF"), "aa:bb:cc:dd:ee:ff");
});

test("isRandomizedMac detects the locally-administered bit", () => {
  assert.equal(isRandomizedMac("AABBCCDDEEFF"), true); // 0xAA & 0x02 = set
  assert.equal(isRandomizedMac("02AABBCCDDEE"), true); // 0x02 & 0x02 = set
  assert.equal(isRandomizedMac("A0BBCCDDEEFF"), false); // 0xA0 & 0x02 = clear
  assert.equal(isRandomizedMac("F4BBCCDDEEFF"), false); // real vendor OUI
});

test("lookupVendor labels an unknown randomized MAC", () => {
  assert.equal(lookupVendor("02:00:00:00:00:01"), "Private (randomized MAC)");
});

test("lookupVendor returns null for an unknown, non-randomized MAC", () => {
  assert.equal(lookupVendor("f4:00:00:00:00:01"), null);
});
