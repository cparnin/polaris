import { test } from "node:test";
import assert from "node:assert/strict";
import { headerSafe, buildNewDeviceAlert, buildHeartbeatAlert } from "./notify.js";
import type { DeviceRow } from "./db.js";
import type { PortScanResult } from "./net/portscan.js";

function device(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: "aa:bb:cc:dd:ee:ff", mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.4.61",
    hostname: "guest-phone", vendor: "Apple", os_guess: null, label: null,
    trusted: 0, is_gateway: 0, is_self: 0, randomized: 0, online: 1,
    first_seen: 0, last_seen: 0, open_ports: null, risk_count: null,
    last_portscan_at: null, ...over,
  };
}

function scanResult(over: Partial<PortScanResult> = {}): PortScanResult {
  return {
    available: true, scanned: true, ip: "192.168.4.61", scannedAt: 0,
    durationMs: 100, ports: [], risks: [], message: null, ...over,
  };
}

test("strips emoji so header encoding can't throw", () => {
  // The exact case that silently killed every notification: an emoji title.
  assert.equal(headerSafe("Polaris test notification 🛰️"), "Polaris test notification");
  assert.equal(headerSafe("New device: Chad's 📱"), "New device: Chad's");
});

test("keeps ordinary and accented Latin-1 text", () => {
  assert.equal(headerSafe("New device on your network: eero router"), "New device on your network: eero router");
  assert.equal(headerSafe("Café Printer"), "Café Printer");
});

test("drops control characters to prevent header injection", () => {
  // A hostile mDNS name must not be able to inject extra headers.
  assert.equal(headerSafe("Evil\r\nX-Injected: 1"), "EvilX-Injected: 1");
  assert.equal(headerSafe("tab\there"), "tabhere");
});

test("new-device alert without a scan keeps the plain headline", () => {
  const a = buildNewDeviceAlert(device());
  // Deliberately NOT "on your network" - see the claim-accuracy test below.
  assert.match(a.title, /^New device seen: guest-phone$/);
  assert.equal(a.priority, "high");
  assert.match(a.message, /192\.168\.4\.61/);
});

test("new-device alert reports the open ports it found", () => {
  const a = buildNewDeviceAlert(
    device(),
    scanResult({
      ports: [
        { port: 80, proto: "tcp", service: "http", product: null, risk: null },
        { port: 443, proto: "tcp", service: "https", product: null, risk: null },
      ],
    })
  );
  assert.match(a.message, /Open ports: 80, 443/);
  assert.equal(a.priority, "high", "no risks → not urgent");
});

test("new-device alert leads with the exposure count and escalates priority", () => {
  const a = buildNewDeviceAlert(
    device({ hostname: "sketchy-nas" }),
    scanResult({
      ports: [{ port: 23, proto: "tcp", service: "telnet", product: null, risk: "Telnet - unencrypted remote login, should not be open" }],
      risks: ["Telnet - unencrypted remote login, should not be open", "SMB/Windows file sharing exposed"],
    })
  );
  assert.match(a.title, /New device \(2 risky ports\): sketchy-nas/);
  assert.equal(a.priority, "urgent");
  assert.match(a.message, /Telnet/);
  assert.match(a.message, /SMB/);
});

test("a clean scan says so explicitly", () => {
  const a = buildNewDeviceAlert(device(), scanResult({ ports: [], risks: [] }));
  assert.match(a.message, /No open ports found/);
});

test("an unnamed device's alert says how to identify it", () => {
  // "New device on your network: Intel Corporate · .59" is a dead end - the
  // recipient has no way to act on it. The router holds the DHCP hostname that
  // Polaris can never see, so point there.
  const msg = buildNewDeviceAlert(
    device({ hostname: null, label: null, vendor: "Intel Corporate", ip: "192.168.4.59", mac: "d4:54:8b:c2:b1:22" }),
    null
  );
  assert.match(msg.message, /router's/);
  assert.match(msg.message, /d4:54:8b:c2:b1:22/);
});

test("a device we can already name doesn't get the identification hint", () => {
  const named = buildNewDeviceAlert(device({ hostname: "Office-TV", mac: "aa:bb:cc:dd:ee:ff" }), null);
  assert.doesNotMatch(named.message, /router's/, "no help needed when it has a real name");

  const labelled = buildNewDeviceAlert(device({ hostname: null, label: "Chad's laptop", mac: "aa:bb:cc:dd:ee:ff" }), null);
  assert.doesNotMatch(labelled.message, /router's/);
});

test("the alert does not claim a device is new to the NETWORK", () => {
  // Polaris only knows a device is new to its own records. A discovery
  // improvement once surfaced four devices that had been on the LAN for
  // months, and each one announced itself as "New device on your network".
  const msg = buildNewDeviceAlert(device({ hostname: "Thermostat" }), null);
  assert.doesNotMatch(msg.title, /on your network/i);
  assert.match(msg.title, /New device seen/);
});

test("the heartbeat says enough to be worth receiving", () => {
  // A monitor that only speaks on bad news is untrustworthy after a long
  // silence: you cannot tell a quiet network from a dead process.
  const msg = buildHeartbeatAlert({ online: 22, total: 26, newSince: 1, risky: 2, days: 7 });
  assert.match(msg.title, /22/);
  assert.match(msg.message, /22 of 26 devices online/);
  assert.match(msg.message, /1 new in the last 7 days/);
  assert.match(msg.message, /2 devices with risky open ports/);
  assert.equal(msg.priority, "low", "routine news must not buzz like an alert");
});

test("the heartbeat stays quiet about risks when there are none", () => {
  const msg = buildHeartbeatAlert({ online: 5, total: 5, newSince: 0, risky: 0, days: 1 });
  assert.doesNotMatch(msg.message, /risky/);
  assert.match(msg.message, /0 new in the last 1 day$/m, "singular day, no trailing s");
});
