import { test } from "node:test";
import assert from "node:assert/strict";
import { networkBase } from "./subnet.js";

test("networkBase masks the host portion for common prefixes", () => {
  assert.equal(networkBase("192.168.1.150", 24), "192.168.1.0");
  assert.equal(networkBase("192.168.4.37", 22), "192.168.4.0");
  assert.equal(networkBase("192.168.7.9", 22), "192.168.4.0"); // /22 spans .4–.7
  assert.equal(networkBase("10.0.5.9", 16), "10.0.0.0");
  assert.equal(networkBase("172.16.200.1", 12), "172.16.0.0");
});

test("networkBase handles the /0 and /32 edges", () => {
  assert.equal(networkBase("8.8.8.8", 0), "0.0.0.0");
  assert.equal(networkBase("8.8.8.8", 32), "8.8.8.8");
});
