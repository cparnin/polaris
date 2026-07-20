import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeenDevice } from "./db.js";

// Point the DB at a throwaway dir before importing the module (which opens the
// DB at import time). Node's test runner isolates each file in its own process,
// so this env override doesn't leak into the other db tests.
const dir = mkdtempSync(join(tmpdir(), "polaris-reap-"));
process.env.POLARIS_DATA_DIR = dir;

let db: typeof import("./db.js");
before(async () => {
  db = await import("./db.js");
});
after(() => rmSync(dir, { recursive: true, force: true }));

function seen(over: Partial<SeenDevice> & { id: string; ip: string }): SeenDevice {
  return {
    mac: null,
    hostname: null,
    vendor: null,
    os_guess: null,
    is_gateway: false,
    is_self: false,
    randomized: false,
    ...over,
  };
}

test("reaps the ip-keyed ghost once the same IP is seen with a MAC", () => {
  const ip = "192.168.4.22";
  // First scan: device answers mDNS but isn't in ARP yet → ip-keyed ghost.
  db.applyScan([seen({ id: `ip:${ip}`, ip, hostname: "Office Speaker" })], 1000);
  db.setLabel(`ip:${ip}`, "My Speaker"); // user labels it

  // Later scan: its MAC is now known → proper MAC-keyed row.
  const mac = "f4:f5:d8:df:5e:ce";
  db.applyScan([seen({ id: mac, mac, ip, hostname: "Office Speaker", vendor: "Google" })], 2000);

  const rows = db.listDevices().filter((d) => d.ip === ip);
  assert.equal(rows.length, 1, "should collapse to a single row for the IP");
  assert.equal(rows[0].id, mac, "the surviving row is the MAC-keyed one");
  assert.equal(rows[0].label, "My Speaker", "the user's label carries over to it");
  assert.equal(db.getDeviceById(`ip:${ip}`), undefined, "ghost row is gone");
});

test("keeps a genuine ip-keyed device that never gets a MAC", () => {
  const ip = "192.168.4.99";
  db.applyScan([seen({ id: `ip:${ip}`, ip, hostname: "Silent-Host" })], 3000);
  assert.ok(db.getDeviceById(`ip:${ip}`), "ip-only device is retained");
});
