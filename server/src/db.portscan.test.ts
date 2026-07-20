import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeenDevice } from "./db.js";

const dir = mkdtempSync(join(tmpdir(), "polaris-ps-"));
process.env.POLARIS_DATA_DIR = dir;

let db: typeof import("./db.js");
before(async () => {
  db = await import("./db.js");
});
after(() => rmSync(dir, { recursive: true, force: true }));

function seen(over: Partial<SeenDevice> & { id: string; ip: string }): SeenDevice {
  return {
    mac: null, hostname: null, vendor: null, os_guess: null,
    is_gateway: false, is_self: false, randomized: false, ...over,
  };
}

test("savePortScan persists ports, risk count and timestamp on the device", () => {
  const mac = "aa:bb:cc:dd:ee:01";
  db.applyScan([seen({ id: mac, mac, ip: "192.168.4.50", hostname: "NAS" })], 1000);

  const ports = [
    { port: 445, proto: "tcp", service: "microsoft-ds", product: null, risk: "SMB exposed" },
    { port: 22, proto: "tcp", service: "ssh", product: "OpenSSH", risk: null },
  ];
  db.savePortScan(mac, ports, 1, 2000);

  const dev = db.getDeviceById(mac)!;
  assert.equal(dev.risk_count, 1);
  assert.equal(dev.last_portscan_at, 2000);
  assert.deepEqual(JSON.parse(dev.open_ports!), ports);
});

test("a later scan of the device leaves its port-scan data intact", () => {
  const mac = "aa:bb:cc:dd:ee:01";
  db.applyScan([seen({ id: mac, mac, ip: "192.168.4.50", hostname: "NAS" })], 3000);
  const dev = db.getDeviceById(mac)!;
  assert.equal(dev.risk_count, 1, "upsert must not clobber persisted scan results");
  assert.ok(dev.open_ports, "open_ports survives a device upsert");
});
