import { test } from "node:test";
import assert from "node:assert/strict";
import { inSubnet, ipToInt, isNonHostMac, isNetworkOrBroadcast, lanUnusableReason } from "./discover.js";
import type { NetInfo } from "./subnet.js";

const net = (ip: string, bits: number): NetInfo => ({
  iface: "en0",
  ip,
  netmaskBits: bits,
  cidr: `${ip}/${bits}`,
});

test("inSubnet works on networks whose first octet is >= 128", () => {
  // The bug this pins: `a & mask === b & mask >>> 0` only coerced the RIGHT
  // side unsigned (>>> binds tighter than ===), so `&`'s signed int32 result
  // never matched once the high bit was set. Every one of these returned false,
  // which meant ARP-known hosts that don't answer ICMP - Windows boxes with the
  // default firewall, ICMP-dropping IoT gear - were silently dropped from the
  // scan on the two most common home network layouts.
  assert.equal(inSubnet("192.168.1.55", net("192.168.1.10", 24)), true);
  assert.equal(inSubnet("172.16.3.55", net("172.16.3.10", 24)), true);
  assert.equal(inSubnet("192.168.4.200", net("192.168.4.1", 22)), true);
  assert.equal(inSubnet("10.0.0.55", net("10.0.0.10", 24)), true); // always worked
});

test("inSubnet rejects addresses outside the subnet", () => {
  assert.equal(inSubnet("192.168.2.55", net("192.168.1.10", 24)), false);
  assert.equal(inSubnet("10.0.0.55", net("192.168.1.10", 24)), false);
  assert.equal(inSubnet("192.168.8.1", net("192.168.4.1", 22)), false); // just past /22
});

test("inSubnet handles the boundary prefix lengths", () => {
  assert.equal(inSubnet("1.2.3.4", net("255.255.255.255", 0)), true, "/0 matches everything");
  assert.equal(inSubnet("192.168.1.10", net("192.168.1.10", 32)), true);
  assert.equal(inSubnet("192.168.1.11", net("192.168.1.10", 32)), false);
});

test("ipToInt is unsigned across the whole range", () => {
  assert.equal(ipToInt("0.0.0.0"), 0);
  assert.equal(ipToInt("192.168.1.1"), 3232235777);
  assert.equal(ipToInt("255.255.255.255"), 4294967295, "must not come back negative");
});

test("isNonHostMac filters broadcast and multicast pseudo-devices", () => {
  // The ARP cache holds these next to real hosts. ff:ff:ff:ff:ff:ff at the
  // network address fired a "new device" push notification.
  assert.equal(isNonHostMac("ffffffffffff"), true, "broadcast");
  assert.equal(isNonHostMac("000000000000"), true, "null");
  assert.equal(isNonHostMac("01005e7ffffa"), true, "IPv4 multicast");
  assert.equal(isNonHostMac("333300000001"), true, "IPv6 multicast");
  // Real MACs must survive - including the locally-administered (randomized)
  // ones modern phones use, which set bit 1, not bit 0, of the first octet.
  assert.equal(isNonHostMac("48a2e6db7070"), false, "Resideo thermostat");
  assert.equal(isNonHostMac("a0764eb67194"), false, "Espressif");
  assert.equal(isNonHostMac("f4f5d8df5ece"), false, "Google");
  assert.equal(isNonHostMac("aa1122334455"), false, "randomized/private MAC");
});

test("isNetworkOrBroadcast excludes the reserved pair, not real hosts", () => {
  assert.equal(isNetworkOrBroadcast("192.168.4.0", net("192.168.4.1", 22)), true);
  assert.equal(isNetworkOrBroadcast("192.168.7.255", net("192.168.4.1", 22)), true);
  assert.equal(isNetworkOrBroadcast("192.168.4.44", net("192.168.4.1", 22)), false);
  // .255 is an ordinary host inside a /22 - only the LAST address is broadcast.
  assert.equal(isNetworkOrBroadcast("192.168.4.255", net("192.168.4.1", 22)), false);
  assert.equal(isNetworkOrBroadcast("192.168.1.255", net("192.168.1.1", 24)), true);
  assert.equal(isNetworkOrBroadcast("192.168.1.10", net("192.168.1.1", 32)), false, "/32 has no pair");
});

test("lanUnusableReason rejects VPN tunnels and /32 default routes", () => {
  // A full-tunnel VPN takes the default route and reports a /32 on utun. The
  // sweep would find exactly one address, so every device on the real LAN would
  // be marked offline - a whole-inventory false alarm every time you connect.
  assert.ok(lanUnusableReason({ ...net("10.8.0.2", 32), iface: "utun4" }), "utun /32");
  assert.ok(lanUnusableReason({ ...net("10.8.0.2", 24), iface: "utun4" }), "utun even with a real mask");
  assert.ok(lanUnusableReason({ ...net("192.168.1.5", 32), iface: "en0" }), "/32 on a real iface");
  assert.ok(lanUnusableReason({ ...net("192.168.1.5", 30), iface: "en0" }), "/30 is too small");
  assert.ok(lanUnusableReason({ ...net("10.8.0.2", 24), iface: "ppp0" }), "dial-up/PPP tunnel");
});

test("lanUnusableReason allows ordinary home networks", () => {
  assert.equal(lanUnusableReason({ ...net("192.168.1.10", 24), iface: "en0" }), null);
  assert.equal(lanUnusableReason({ ...net("192.168.4.30", 22), iface: "en0" }), null);
  assert.equal(lanUnusableReason({ ...net("10.0.0.5", 8), iface: "en1" }), null);
});
