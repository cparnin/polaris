import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWildcardName, parseNodeStatus } from "./netbios.js";

/** Build a synthetic NBSTAT response listing the given names in its RDATA. */
function buildResponse(names: { name: string; suffix: number; group?: boolean }[]): Buffer {
  const header = Buffer.from([0, 0, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0]); // an=1
  const answerName = encodeWildcardName(); // 34 bytes, matches the query name
  const meta = Buffer.from([0x00, 0x21, 0x00, 0x01, 0, 0, 0, 0]); // NBSTAT, IN, ttl
  const entries = names.map(({ name, suffix, group }) => {
    const e = Buffer.alloc(18);
    e.write(name.padEnd(15, " ").slice(0, 15), 0, "ascii");
    e[15] = suffix;
    e.writeUInt16BE(group ? 0x8000 : 0x0400, 16); // group flag vs unique+active
    return e;
  });
  const rdata = Buffer.concat([Buffer.from([names.length]), ...entries]);
  const rdlen = Buffer.alloc(2);
  rdlen.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([header, answerName, meta, rdlen, rdata]);
}

test("parseNodeStatus extracts the unique <00> workstation name", () => {
  const buf = buildResponse([
    { name: "WORKGROUP", suffix: 0x00, group: true }, // skipped (group)
    { name: "IRIS-PC", suffix: 0x00 }, // the machine name we want
    { name: "IRIS-PC", suffix: 0x20 }, // server service — not <00>
  ]);
  assert.equal(parseNodeStatus(buf), "IRIS-PC");
});

test("parseNodeStatus trims padding on a lone name", () => {
  assert.equal(parseNodeStatus(buildResponse([{ name: "NAS01", suffix: 0x00 }])), "NAS01");
});

test("parseNodeStatus returns null when there is no answer", () => {
  const noAnswer = Buffer.from([0, 0, 0x84, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(parseNodeStatus(noAnswer), null);
  assert.equal(parseNodeStatus(Buffer.alloc(4)), null);
});
