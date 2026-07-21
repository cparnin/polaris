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

test("normalizeMac handles macOS arp output with leading zeros stripped", () => {
  // `arp -an` prints 44:7:b:e5:19:84, not 44:07:0b:e5:19:84. Stripping
  // separators and requiring 12 hex chars rejected these outright, so any
  // device with a low-valued octet lost its MAC - and with it its identity.
  assert.equal(normalizeMac("44:7:b:e5:19:84"), "44070BE51984");
  assert.equal(normalizeMac("c:83:cc:18:57:fa"), "0C83CC1857FA");
  assert.equal(normalizeMac("5c:62:8b:a3:ac:0"), "5C628BA3AC00");
  assert.equal(normalizeMac("0:0:0:0:0:1"), "000000000001");
  assert.equal(normalizeMac("1:0:5e:0:0:fb"), "01005E0000FB", "multicast still parses");
});

test("normalizeMac still rejects genuinely malformed input", () => {
  assert.equal(normalizeMac("44:7:b:e5:19"), null, "only five octets");
  assert.equal(normalizeMac("44:7:b:e5:19:84:99"), null, "seven octets");
  assert.equal(normalizeMac("zz:7:b:e5:19:84"), null, "non-hex");
  assert.equal(normalizeMac("44:777:b:e5:19:84"), null, "three-digit octet");
  assert.equal(normalizeMac(""), null);
});

test("the OUI table resolves real vendors across the whole alphabet range", () => {
  // The table is binary-searched rather than parsed into an object (that cost
  // 14MB of RSS, measured). These span the first, last and middle of the file,
  // so a broken search shows up rather than passing on one lucky lookup.
  assert.equal(lookupVendor("00:00:01:11:22:33"), "Xerox Corporation", "first lines of the table");
  assert.equal(lookupVendor("e4:19:7f:cd:ad:d2"), "eero inc.", "the gateway on a real network");
  assert.equal(lookupVendor("48:a2:e6:db:70:70"), "Resideo", "mid-table");
  assert.equal(lookupVendor("d4:54:8b:c2:b1:22"), "Intel Corporate");
  assert.equal(lookupVendor("fc:fe:c2:00:00:00"), "Invensys Controls UK Limited", "the very last line");
});

test("vendor names with non-ASCII characters survive the table round-trip", () => {
  // Read as latin1 this returned "Burg-WÃ¤chter Kg". 243 entries have umlauts
  // or fullwidth CJK punctuation.
  assert.equal(lookupVendor("30:42:25:00:00:00"), "Burg-Wächter Kg");
  assert.equal(lookupVendor("20:32:33:00:00:00"), "Shenzhen Bilian Electronic Co.，Ltd");
});

test("an unknown, non-randomized OUI still resolves to null", () => {
  // Binary search must not report a near-miss neighbour as a hit. 00:FF:FF
  // sits between real entries; 01:02:03 has the multicast bit clear, so it
  // can't be rescued by the randomized-MAC fallback either.
  assert.equal(lookupVendor("00:ff:ff:00:00:01"), null);
  assert.equal(lookupVendor("01:02:03:04:05:06"), null);
});
