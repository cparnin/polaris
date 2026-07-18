import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, parsePtrAnswer } from "./mdns.js";

/** Encode a dotted name as length-prefixed DNS labels + root terminator. */
function encodeLabels(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split(".")) {
    const b = Buffer.from(label, "ascii");
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A minimal mDNS response carrying one PTR answer pointing at `target`. */
function buildPtrResponse(target: string): Buffer {
  const header = Buffer.from([0, 0, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0]); // an=1
  const answerName = Buffer.from([0x00]); // root as the record's own name
  const meta = Buffer.from([0x00, 0x0c, 0x00, 0x01, 0, 0, 0, 0]); // type PTR, class IN, ttl
  const rdata = encodeLabels(target);
  const rdlen = Buffer.alloc(2);
  rdlen.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([header, answerName, meta, rdlen, rdata]);
}

test("parsePtrAnswer reads the PTR target name", () => {
  assert.equal(parsePtrAnswer(buildPtrResponse("Chads-iMac.local")), "Chads-iMac.local");
});

test("parsePtrAnswer returns null without a PTR answer", () => {
  const noAnswer = Buffer.from([0, 0, 0x84, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(parsePtrAnswer(noAnswer), null);
});

test("cleanName strips the .local suffix and trailing dots", () => {
  assert.equal(cleanName("Living-Room.local."), "Living-Room");
  assert.equal(cleanName("Office-TV.local"), "Office-TV");
  assert.equal(cleanName("plain-name"), "plain-name");
});
