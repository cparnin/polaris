import { test } from "node:test";
import assert from "node:assert/strict";
import { hostnameOf, isLoopbackHost, isSameOriginRequest } from "./security.js";

test("hostnameOf strips ports and brackets", () => {
  assert.equal(hostnameOf("localhost:4000"), "localhost");
  assert.equal(hostnameOf("127.0.0.1"), "127.0.0.1");
  assert.equal(hostnameOf("[::1]:4000"), "::1");
  assert.equal(hostnameOf("EVIL.COM:80"), "evil.com");
});

test("isLoopbackHost allows loopback names and addresses", () => {
  for (const h of ["localhost", "localhost:4000", "127.0.0.1", "127.0.0.1:4000", "127.5.5.5", "[::1]:4000", "::1"]) {
    assert.equal(isLoopbackHost(h), true, `${h} should be allowed`);
  }
});

test("isLoopbackHost rejects non-loopback hosts (DNS-rebinding defense)", () => {
  for (const h of ["evil.com", "attacker.com:4000", "192.168.1.50", "10.0.0.1:4000", ""]) {
    assert.equal(isLoopbackHost(h), false, `${h} should be rejected`);
  }
});

test("isLoopbackHost rejects hostnames that merely START with 127.", () => {
  // The bug this pins: `host.startsWith("127.")` accepted all of these. An
  // attacker points 127.0.0.1.evil.com at loopback, and their page is then
  // same-origin with Polaris and can read the whole network map.
  // 127.0.0.1.nip.io already resolves to 127.0.0.1 publicly - no setup needed.
  for (const h of [
    "127.0.0.1.evil.com",
    "127.0.0.1.evil.com:4000",
    "127.evil.com",
    "127.0.0.1.nip.io:4000",
    "127.0.0.1x",
    "127.1.2.3.4",
    "127.999.1.1",
  ]) {
    assert.equal(isLoopbackHost(h), false, `${h} should be rejected`);
  }
});

test("isSameOriginRequest allows same-origin and origin-less requests", () => {
  // curl and same-origin form posts send no Origin at all.
  assert.equal(isSameOriginRequest({}), true);
  assert.equal(isSameOriginRequest({ secFetchSite: "same-origin" }), true);
  assert.equal(isSameOriginRequest({ secFetchSite: "none" }), true); // typed URL
  assert.equal(isSameOriginRequest({ origin: "http://127.0.0.1:4000" }), true);
  assert.equal(isSameOriginRequest({ origin: "http://localhost:5173" }), true);
});

test("isSameOriginRequest rejects cross-site POSTs (CSRF defense)", () => {
  // The attack: an auto-submitting form on any page you visit hits /api/quit,
  // which shells out to `launchctl bootout` and kills the monitor till login.
  assert.equal(isSameOriginRequest({ secFetchSite: "cross-site" }), false);
  assert.equal(isSameOriginRequest({ secFetchSite: "same-site" }), false);
  assert.equal(isSameOriginRequest({ origin: "https://evil.com" }), false);
  // The rebinding hostname must not sneak in through the Origin either.
  assert.equal(isSameOriginRequest({ origin: "http://127.0.0.1.evil.com" }), false);
  assert.equal(isSameOriginRequest({ origin: "not a url" }), false);
});

test("isSameOriginRequest honors ALLOWED_HOSTS for deliberate off-loopback use", () => {
  assert.equal(isSameOriginRequest({ origin: "http://polaris.lan" }), false);
  assert.equal(isSameOriginRequest({ origin: "http://polaris.lan" }, ["polaris.lan"]), true);
});

test("isLoopbackHost honors the explicit allow-list", () => {
  assert.equal(isLoopbackHost("polaris.lan", []), false);
  assert.equal(isLoopbackHost("polaris.lan", ["polaris.lan"]), true);
});
