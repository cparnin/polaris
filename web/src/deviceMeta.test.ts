import { test, expect } from "vitest";
import { deviceIcon, scanStatus, SCAN_STALE_MS } from "./deviceMeta.js";
import { makeDevice } from "./testDevice.js";

test("deviceIcon flags the gateway first", () => {
  expect(deviceIcon(makeDevice({ is_gateway: 1, vendor: "Apple" }))).toBe("🛜");
});

test("deviceIcon infers a category from vendor/hostname", () => {
  expect(deviceIcon(makeDevice({ hostname: "Chads-MacBook-Pro" }))).toBe("🍎");
  expect(deviceIcon(makeDevice({ vendor: "Canon" }))).toBe("🖨️");
  expect(deviceIcon(makeDevice({ vendor: "Sonos" }))).toBe("🔊");
});

test("deviceIcon marks randomized MACs, then unknowns", () => {
  expect(deviceIcon(makeDevice({ randomized: 1 }))).toBe("🕶️");
  expect(deviceIcon(makeDevice({ vendor: "Weird Unknown Co" }))).toBe("❔");
});

test("a recent clean scan is clean, an old one downgrades to stale", () => {
  // Scan results never expire in the DB; without the downgrade a device
  // scanned clean months ago wears a confident green check forever.
  const recent = makeDevice({ last_portscan_at: Date.now() - 1000, risk_count: 0 });
  expect(scanStatus(recent).status).toBe("clean");

  const old = makeDevice({ last_portscan_at: Date.now() - SCAN_STALE_MS - 1000, risk_count: 0 });
  expect(scanStatus(old).status).toBe("stale");
});

test("a risky scan stays risky at any age - an old warning is still a warning", () => {
  const old = makeDevice({ last_portscan_at: Date.now() - SCAN_STALE_MS * 3, risk_count: 2 });
  expect(scanStatus(old)).toEqual({ status: "risky", riskCount: 2 });
});

test("never-scanned devices are unscanned, not stale", () => {
  expect(scanStatus(makeDevice({ last_portscan_at: null })).status).toBe("unscanned");
});
