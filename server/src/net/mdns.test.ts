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

/** A 12-byte DNS header with the given question/answer counts. */
function header(qd: number, an: number): Buffer {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(qd, 4);
  h.writeUInt16BE(an, 6);
  return h;
}

test("parsePtrAnswer survives hostile packets without spinning", () => {
  // These sockets are bound on all interfaces, and this parser shares the one
  // thread that serves the API and runs scans - so an unbounded loop here is a
  // remote CPU-denial bug. A 12-byte packet claiming qdcount=65535 used to burn
  // ~110ms; ~9/sec pinned the process. Each case must be null/short-circuit and
  // fast, and none may throw.
  const cases: Array<[string, Buffer]> = [
    ["qdcount lies about a 12-byte packet", header(65535, 0)],
    ["ancount lies about a 12-byte packet", header(0, 65535)],
    ["both counts lie", header(65535, 65535)],
    ["truncated RR header", Buffer.concat([header(0, 1), Buffer.from([0x00])])],
    ["rr header cut mid-field", Buffer.concat([header(0, 1), Buffer.from([0x00, 0x00, 0x0c, 0x00])])],
    // 0xc0 0x0c is a compression pointer back to offset 12 - itself.
    ["self-referential compression pointer", Buffer.concat([header(0, 1), Buffer.from([0xc0, 0x0c])])],
    ["pointer past the end of the buffer", Buffer.concat([header(0, 1), Buffer.from([0xc0, 0xff])])],
    ["label length runs past the end", Buffer.concat([header(0, 1), Buffer.from([0x40, 0x41])])],
    ["empty buffer", Buffer.alloc(0)],
    ["header only", header(0, 0)],
  ];

  for (const [label, buf] of cases) {
    const started = process.hrtime.bigint();
    let result: string | null = null;
    assert.doesNotThrow(() => {
      result = parsePtrAnswer(buf);
    }, `${label} must not throw`);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 20, `${label} took ${ms.toFixed(1)}ms - parser is spinning`);
    assert.ok(result === null || typeof result === "string", `${label} returned junk`);
  }
});

test("parsePtrAnswer still reads a well-formed answer", () => {
  // Guard against "fixed the DoS by breaking the parser".
  const name = encodeLabels("Living-Room-TV.local");
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(12, 0); // type PTR
  rr.writeUInt16BE(1, 2); // class IN
  rr.writeUInt16BE(name.length, 8); // rdlength
  const pkt = Buffer.concat([header(0, 1), Buffer.from([0x00]), rr, name]);
  assert.equal(parsePtrAnswer(pkt), "Living-Room-TV.local");
});
