import { test } from "node:test";
import assert from "node:assert/strict";
import { riskFor, parsePorts } from "./portscan.js";

test("flags classic remote-access exposures", () => {
  assert.match(riskFor(23, "telnet") ?? "", /Telnet/);
  assert.match(riskFor(3389, null) ?? "", /RDP/);
  assert.match(riskFor(5900, null) ?? "", /VNC/);
  assert.match(riskFor(2375, null) ?? "", /Docker/);
});

test("flags file sharing and transfer", () => {
  assert.match(riskFor(445, "microsoft-ds") ?? "", /SMB/);
  assert.match(riskFor(21, "ftp") ?? "", /FTP/);
  assert.match(riskFor(2049, null) ?? "", /NFS/);
});

test("flags unauthenticated printing", () => {
  assert.match(riskFor(9100, "jetdirect") ?? "", /JetDirect/);
  assert.match(riskFor(515, "printer") ?? "", /LPD/);
});

test("flags IoT management surfaces", () => {
  assert.match(riskFor(1900, null) ?? "", /UPnP/);
  assert.match(riskFor(161, "snmp") ?? "", /SNMP/);
  assert.match(riskFor(1883, null) ?? "", /MQTT/);
  assert.match(riskFor(554, "rtsp") ?? "", /RTSP/);
});

test("flags exposed data stores by name", () => {
  assert.match(riskFor(6379, null) ?? "", /Redis/);
  assert.match(riskFor(27017, null) ?? "", /MongoDB/);
  assert.match(riskFor(3306, null) ?? "", /MySQL/);
});

test("does NOT flag ports that are normal on consumer gear", () => {
  // Chromecast / Google Cast
  for (const p of [8008, 8009, 8443, 9000, 10001, 10010]) {
    assert.equal(riskFor(p, "http"), null, `port ${p} should not be flagged`);
  }
  assert.equal(riskFor(80, "http"), null);
  assert.equal(riskFor(443, "ssl/https"), null);
  assert.equal(riskFor(631, "ipp"), null); // modern IPP printing is fine
  assert.equal(riskFor(22, "ssh"), null); // encrypted, expected on servers/NAS
  assert.equal(riskFor(53, "domain"), null);
  assert.equal(riskFor(9999, "abyss"), null); // TP-Link Kasa control port
});

test("an unidentified service is marked as a guess, not a detection", () => {
  // The eero case: nmap reports "ssl/nessus" on 3001 because that port was
  // Nessus's in the 2000s - it has NOT found a vulnerability scanner running on
  // your router. Presented as a detection, that's an alarming false claim.
  const out = [
    "PORT     STATE SERVICE     VERSION",
    "80/tcp   open  http        Golang net/http server",
    "3001/tcp open  ssl/nessus",
    "5357/tcp open  wsdapi?",
  ].join("\n");
  const ports = parsePorts(out);

  const http = ports.find((p) => p.port === 80);
  assert.equal(http?.guessed, false, "a version banner is a real identification");

  const tls = ports.find((p) => p.port === 3001);
  assert.equal(tls?.service, "ssl/nessus");
  assert.equal(tls?.guessed, true, "no version info -> port-table guess");
  assert.equal(tls?.risk, null, "a guessed name must not raise an alarm");

  const marked = ports.find((p) => p.port === 5357);
  assert.equal(marked?.guessed, true, "nmap's own '?' marker is honored");
  assert.equal(marked?.service, "wsdapi", "the marker itself isn't shown as part of the name");
});

test("a guessed service name cannot invent a risk, but the port still can", () => {
  // Port-number rules are evidence in themselves and must keep firing.
  const guessedOnly = parsePorts("4445/tcp open  microsoft-ds");
  assert.equal(guessedOnly[0]?.risk, null, "guessed 'microsoft-ds' on a random port: no alarm");

  const realPort = parsePorts("445/tcp  open  microsoft-ds");
  assert.ok(realPort[0]?.risk, "445 is SMB by number, flagged regardless of the name");

  const confirmed = parsePorts("4445/tcp open  microsoft-ds Samba smbd 4.15.13");
  assert.ok(confirmed[0]?.risk, "a CONFIRMED SMB service on an odd port is still a real finding");
});
