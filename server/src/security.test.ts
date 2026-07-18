import { test } from "node:test";
import assert from "node:assert/strict";
import { hostnameOf, isLoopbackHost } from "./security.js";

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

test("isLoopbackHost honors the explicit allow-list", () => {
  assert.equal(isLoopbackHost("iris.lan", []), false);
  assert.equal(isLoopbackHost("iris.lan", ["iris.lan"]), true);
});
