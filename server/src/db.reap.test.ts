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

test("sweeps a pre-existing ghost duplicate stranded on an old subnet", () => {
  const oldIp = "192.168.1.110";
  const mac = "bc:df:58:51:fb:f8";
  db.applyScan([seen({ id: mac, mac, ip: oldIp, hostname: "Living Room TV" })], 4000);

  // Seed a legacy ghost row directly - the kind older builds left behind, which
  // is never "seen" again once the network moved to a different subnet.
  db.db
    .prepare(
      `INSERT INTO devices (id, mac, ip, hostname, trusted, is_gateway, is_self,
                            randomized, online, first_seen, last_seen)
       VALUES (?, NULL, ?, ?, 0, 0, 0, 0, 0, ?, ?)`
    )
    .run(`ip:${oldIp}`, oldIp, "Living Room TV", 4000, 4000);
  assert.ok(db.getDeviceById(`ip:${oldIp}`), "ghost seeded");

  // An unrelated later scan on the current subnet still sweeps it.
  db.applyScan([seen({ id: "ip:192.168.4.5", ip: "192.168.4.5" })], 5000);
  assert.equal(db.getDeviceById(`ip:${oldIp}`), undefined, "stale ghost is gone");
  assert.ok(db.getDeviceById(mac), "the MAC-keyed row (with its name) survives");
});

test("forgetDevice removes a device and reports whether it existed", () => {
  const mac = "aa:bb:cc:00:11:22";
  db.applyScan([seen({ id: mac, mac, ip: "192.168.4.77", hostname: "Doomed" })], 6000);
  assert.ok(db.getDeviceById(mac));
  assert.equal(db.forgetDevice(mac), true);
  assert.equal(db.getDeviceById(mac), undefined);
  assert.equal(db.forgetDevice(mac), false, "forgetting an unknown device reports false");
});

test("a device that drops out of the ARP cache does NOT flap offline", () => {
  // macOS expires ARP entries in ~20 minutes, so a device sitting right there
  // routinely reappears as `ip:<addr>` with no MAC. The sweep deleted that
  // ghost but the surviving MAC row was never in seenIds, so it was marked
  // offline - with a bogus event and a frozen last_seen - then flipped back on
  // the next scan. That's the source of the near-equal online/offline event
  // counts in the feed.
  const ip = "192.168.4.31";
  const mac = "aa:bb:cc:11:22:33";
  db.applyScan([seen({ id: mac, mac, ip, hostname: "Thermostat" })], 10_000);
  assert.equal(db.getDeviceById(mac)?.online, 1);

  // Same device, same IP - but the ARP entry expired, so it arrives ip-keyed.
  const diff = db.applyScan([seen({ id: `ip:${ip}`, ip, hostname: "Thermostat" })], 11_000);

  const row = db.getDeviceById(mac);
  assert.equal(row?.online, 1, "still online - it was literally just seen");
  assert.equal(row?.last_seen, 11_000, "last_seen advances to this scan");
  assert.deepEqual(diff.wentOffline, [], "no spurious offline transition");
  assert.deepEqual(diff.newDevices, [], "the swept ghost is not reported as new");
  assert.equal(db.getDeviceById(`ip:${ip}`), undefined, "ghost row still gets swept");
});

test("sweeping a ghost takes its events with it", () => {
  // forgetDevice() deletes a device's events; the sweep didn't, so orphaned
  // rows accumulated pointing at ids that no longer exist.
  const ip = "192.168.4.32";
  const mac = "aa:bb:cc:44:55:66";
  db.applyScan([seen({ id: `ip:${ip}`, ip })], 20_000); // ghost + new_device event
  const orphansBefore = db.db
    .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM events WHERE device_id = ?")
    .get(`ip:${ip}`);
  assert.ok((orphansBefore?.n ?? 0) > 0, "ghost has events to orphan");

  db.applyScan([seen({ id: mac, mac, ip })], 21_000); // MAC row appears → sweep

  const orphansAfter = db.db
    .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM events WHERE device_id = ?")
    .get(`ip:${ip}`);
  assert.equal(orphansAfter?.n, 0, "no events left pointing at the deleted ghost");
});

test("a device genuinely absent still goes offline", () => {
  // The flapping fix must not make devices immortal - it only delays the call
  // by one scan (see MISSES_BEFORE_OFFLINE).
  const mac = "aa:bb:cc:77:88:99";
  db.applyScan([seen({ id: mac, mac, ip: "192.168.4.33" })], 30_000);
  const elsewhere = [seen({ id: "ip:192.168.4.34", ip: "192.168.4.34" })];
  db.applyScan(elsewhere, 31_000); // first miss: forgiven
  const diff = db.applyScan(elsewhere, 32_000); // second: real
  assert.ok(diff.wentOffline.includes(mac), "absent device is reported offline");
  assert.equal(db.getDeviceById(mac)?.online, 0);
});

test("one missed scan does not take a device offline", () => {
  // A dozing phone or a Wi-Fi hiccup shouldn't write an offline event and then
  // an online event minutes later, forever. That churn was most of the feed.
  const mac = "aa:bb:cc:aa:aa:01";
  const other = "aa:bb:cc:aa:aa:02";
  db.applyScan([seen({ id: mac, mac, ip: "192.168.4.60" }), seen({ id: other, mac: other, ip: "192.168.4.61" })], 40_000);

  const miss1 = db.applyScan([seen({ id: other, mac: other, ip: "192.168.4.61" })], 41_000);
  assert.equal(miss1.wentOffline.includes(mac), false, "first miss is forgiven");
  assert.equal(db.getDeviceById(mac)?.online, 1, "still shown as online");

  const miss2 = db.applyScan([seen({ id: other, mac: other, ip: "192.168.4.61" })], 42_000);
  assert.ok(miss2.wentOffline.includes(mac), "second consecutive miss is real");
  assert.equal(db.getDeviceById(mac)?.online, 0);
});

test("reappearing before the second miss clears the strike", () => {
  const mac = "aa:bb:cc:aa:aa:03";
  const other = "aa:bb:cc:aa:aa:04";
  const both = [seen({ id: mac, mac, ip: "192.168.4.62" }), seen({ id: other, mac: other, ip: "192.168.4.63" })];
  db.applyScan(both, 50_000);
  db.applyScan([both[1]], 51_000); // missed once
  db.applyScan(both, 52_000); // back
  assert.equal(db.getDeviceById(mac)?.missed_scans, 0, "strike reset on sighting");

  // So the next single miss is again forgiven rather than counting as the 2nd.
  const diff = db.applyScan([both[1]], 53_000);
  assert.equal(diff.wentOffline.includes(mac), false, "counter restarted, not carried over");
});
