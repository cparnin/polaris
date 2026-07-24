import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The home-network anchor decides whether the network we just scanned is the
 * one we monitor (push alerts, autoscan) or somebody else's (record quietly).
 * Getting this wrong in one direction spams the phone with a friend's entire
 * household; wrong in the other direction, a genuinely new device at home is
 * silently swallowed. These tests pin the decision table.
 */

const dir = mkdtempSync(join(tmpdir(), "polaris-home-"));
process.env.POLARIS_DATA_DIR = dir;

// Dynamic import AFTER the env var is set, so the module opens its DB in the
// temp dir (node:test runs each file in its own process, so this is safe).
const home = await import("./home.js");
const { setMeta, getMeta } = await import("./db.js");

before(() => setMeta("homeGateways", "[]"));
after(() => {
  delete process.env.POLARIS_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const HOME_GW = "e4:19:7f:cd:ad:d2";
const MOMS_GW = "fc:12:63:24:14:30";

test("first scan ever adopts the current gateway as home", () => {
  setMeta("homeGateways", "[]");
  const away = home.updateHomeState("192.168.4.1", HOME_GW);
  assert.equal(away, false, "the adopting scan is by definition at home");
  assert.deepEqual(home.getHomeGateways(), [HOME_GW]);
});

test("an anchored gateway is home; any other gateway is away", () => {
  setMeta("homeGateways", JSON.stringify([HOME_GW]));
  assert.equal(home.updateHomeState("192.168.4.1", HOME_GW), false);
  assert.equal(home.updateHomeState("192.168.1.1", MOMS_GW), true);
  // Being away must NOT adopt: that's the whole bug this feature fixes.
  assert.deepEqual(home.getHomeGateways(), [HOME_GW]);
});

test("MAC comparison is case-insensitive", () => {
  setMeta("homeGateways", JSON.stringify([HOME_GW]));
  assert.equal(home.updateHomeState("192.168.4.1", HOME_GW.toUpperCase()), false);
});

test("an unresolvable gateway MAC counts as away, and adopts nothing", () => {
  // The kernel talks to the home router constantly, so its ARP entry is
  // effectively always present; a gateway we can't identify is a strange
  // network, and muting is the cheaper mistake.
  setMeta("homeGateways", JSON.stringify([HOME_GW]));
  assert.equal(home.updateHomeState("10.0.0.1", null), true);

  setMeta("homeGateways", "[]");
  assert.equal(home.updateHomeState("10.0.0.1", null), true);
  assert.deepEqual(home.getHomeGateways(), [], "null must never be anchored");
});

test("anchorCurrentGateway blesses the network of the last scan", () => {
  setMeta("homeGateways", JSON.stringify([HOME_GW]));
  home.updateHomeState("192.168.1.1", MOMS_GW);
  assert.equal(home.isAway(), true);

  const status = home.anchorCurrentGateway();
  assert.equal(status.away, false, "anchoring the current network ends 'away' immediately");
  assert.deepEqual(status.gateways.sort(), [HOME_GW, MOMS_GW].sort());
});

test("anchorCurrentGateway refuses when no gateway MAC is known", () => {
  home.updateHomeState(null, null);
  assert.throws(() => home.anchorCurrentGateway());
});

test("removeHomeGateway un-anchors and re-evaluates the current network", () => {
  setMeta("homeGateways", JSON.stringify([HOME_GW, MOMS_GW]));
  home.updateHomeState("192.168.1.1", MOMS_GW);
  assert.equal(home.isAway(), false);

  assert.equal(home.removeHomeGateway(MOMS_GW), true);
  assert.equal(home.isAway(), true, "we just stopped being home");
  assert.deepEqual(home.getHomeGateways(), [HOME_GW]);
  assert.equal(home.removeHomeGateway(MOMS_GW), false, "already gone");
});

test("a corrupt meta row degrades to 'nothing anchored', not a crash", () => {
  for (const junk of ["not json", "42", '{"a":1}', '["ok", 7, null]']) {
    setMeta("homeGateways", junk);
    const got = home.getHomeGateways();
    assert.ok(Array.isArray(got), `${junk} must yield an array`);
    assert.ok(
      got.every((m) => typeof m === "string"),
      `${junk} must yield only strings`
    );
  }
  // Adoption then repairs the row on the next scan.
  setMeta("homeGateways", "not json");
  assert.equal(home.updateHomeState("192.168.4.1", HOME_GW), false);
  assert.deepEqual(JSON.parse(getMeta("homeGateways") ?? "[]"), [HOME_GW]);
});
