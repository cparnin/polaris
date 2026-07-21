import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import { detectNetwork, networkBase, type NetInfo } from "./subnet.js";
import { normalizeMac, formatMac, lookupVendor, isRandomizedMac } from "./vendors.js";
import { mdnsReverseBatch, mdnsServiceBatch, type ServiceName } from "./mdns.js";
import { netbiosBatch } from "./netbios.js";

const pexec = promisify(execFile);

/** Max hosts to sweep. Guards against someone pointing this at a /16. */
const MAX_SWEEP_HOSTS = 4096;
/** Concurrent `ping` processes for the TTL pass over already-found hosts. */
const TTL_CONCURRENCY = 32;
/** Discard service (RFC 863) - closed almost everywhere, harmless if not. */
const POKE_PORT = 9;
/** Datagrams in flight per batch; more than this starts returning ENOBUFS. */
const POKE_CHUNK = 128;
/** How long to let ARP replies land after poking, before reading the cache. */
const ARP_SETTLE_MS = 1200;

export interface DiscoveredHost {
  ip: string;
  mac: string | null; // colon notation, lowercase
  vendor: string | null;
  hostname: string | null;
  osGuess: string | null;
  randomizedMac: boolean;
}

export interface ScanResult {
  net: NetInfo;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  hosts: DiscoveredHost[];
}

/** Enumerate all usable host IPs in a subnet (excludes network + broadcast). */
function hostsInSubnet(net: NetInfo): string[] {
  const base = networkBase(net.ip, net.netmaskBits);
  const p = base.split(".").map(Number);
  const baseInt = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const size = 2 ** (32 - net.netmaskBits);
  const count = Math.min(size, MAX_SWEEP_HOSTS);
  const ips: string[] = [];
  // Skip .0 (network) and the last address (broadcast) for normal-sized subnets.
  const start = size > 2 ? 1 : 0;
  const end = size > 2 ? count - 1 : count;
  for (let i = start; i < end; i++) {
    const n = (baseInt + i) >>> 0;
    ips.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return ips;
}

/** Ping a host once (1s timeout). Returns its reply TTL, or null if no reply. */
async function pingOne(ip: string): Promise<number | null> {
  try {
    // macOS ping: -c1 one packet, -t1 give up after 1 second.
    const { stdout } = await pexec("ping", ["-c", "1", "-t", "1", ip], { timeout: 2000 });
    const ttl = stdout.match(/ttl=(\d+)/i)?.[1];
    return ttl ? Number(ttl) : 0; // replied but TTL unparsed → 0 (still "alive")
  } catch {
    return null;
  }
}

/** Coarse OS family guess from a reply TTL (initial TTL by platform). */
function osGuessFromTtl(ttl: number | null): string | null {
  if (ttl === null || ttl === 0) return null;
  if (ttl <= 64) return "Linux / Apple / Android";
  if (ttl <= 128) return "Windows";
  return "Router / IoT";
}

/**
 * Nudge every address in the subnet so the kernel resolves its MAC.
 *
 * Sending a UDP datagram to an address forces an ARP request for it before the
 * packet can go out. That's the whole trick: we never care about a reply, only
 * about the ARP table the kernel fills in as a side effect. One socket, one
 * datagram per host, zero subprocesses.
 *
 * Port 9 is the standard discard service - anything actually listening throws
 * the bytes away, and the overwhelming majority of hosts simply have it closed,
 * which is equally fine. The payload is empty. This is quieter on the wire than
 * the ICMP sweep it replaced.
 */
async function arpPoke(ips: string[]): Promise<void> {
  const sock = createSocket("udp4");
  const EMPTY = Buffer.alloc(0);
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, () => resolve());
    });
    // Errors here are per-datagram and expected (unreachable hosts, ENOBUFS on
    // a burst). None of them mean the sweep failed.
    sock.on("error", () => {});

    // Chunked rather than all at once: 1000+ simultaneous sends overflow the
    // socket buffer and start throwing ENOBUFS instead of queueing.
    for (let i = 0; i < ips.length; i += POKE_CHUNK) {
      const chunk = ips.slice(i, i + POKE_CHUNK);
      await Promise.all(
        chunk.map(
          (ip) =>
            new Promise<void>((resolve) => {
              sock.send(EMPTY, 0, 0, POKE_PORT, ip, () => resolve());
            }),
        ),
      );
    }
  } catch {
    /* couldn't bind - fall through; the ARP cache may still hold recent hosts */
  } finally {
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  }
  // ARP replies come back asynchronously; give the cache a moment to fill.
  await new Promise((r) => setTimeout(r, ARP_SETTLE_MS));
}

/**
 * Discover live hosts, ARP-first.
 *
 * This used to ping every address in the subnet: on a /22 that's 1022 `ping`
 * subprocesses every scan - ~294k process spawns a day to find ~20 devices,
 * 8 seconds of wall clock, and ~46MB of RSS churn per sweep that macOS was slow
 * to hand back. Poking with UDP and reading the ARP table instead is ~1.5s,
 * flat on memory, and finds MORE hosts: ARP resolves for devices that ignore
 * ICMP entirely, which is most of the interesting ones (Windows boxes behind
 * the default firewall, locked-down IoT gear).
 *
 * We still ping - but only the handful of addresses that actually resolved, and
 * only to read the reply TTL for the OS-family guess. ~20 subprocesses, not
 * 1022. A host that doesn't answer ICMP simply has no OS hint, which is exactly
 * what happened before too.
 */
async function sweepSubnet(
  net: NetInfo,
  skipTtlFor?: (ip: string, mac: string | null) => boolean,
): Promise<{
  ttls: Map<string, number | null>;
  arp: Map<string, string>;
}> {
  await arpPoke(hostsInSubnet(net));
  const arp = await readArpTable();

  const live = new Map<string, number | null>();
  for (const ip of arp.keys()) {
    if (inSubnet(ip, net) && !isNetworkOrBroadcast(ip, net)) live.set(ip, null);
  }

  // TTL pass over just the live hosts, bounded so a big subnet full of devices
  // still can't spawn an unreasonable number of processes at once. Hosts we've
  // already classified are skipped entirely, so a steady-state scan spawns no
  // ping processes at all - the OS family of a device doesn't change.
  const targets = [...live.keys()].filter(
    (ip) => !skipTtlFor?.(ip, arp.get(ip) ?? null),
  );
  let cursor = 0;
  async function ttlWorker(): Promise<void> {
    while (cursor < targets.length) {
      const ip = targets[cursor++];
      const ttl = await pingOne(ip);
      if (ttl !== null) live.set(ip, ttl);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(TTL_CONCURRENCY, targets.length) }, ttlWorker),
  );

  return { ttls: live, arp };
}

/**
 * MACs that are addressing modes, not machines.
 *
 * The ARP cache holds broadcast (ff:ff:ff:ff:ff:ff) and multicast entries
 * alongside real hosts. They have to be filtered or they surface as devices and
 * fire "new device" alerts - that's how ff:ff:ff:ff:ff:ff at the network
 * address earned itself a push notification. Takes a normalized MAC.
 */
export function isNonHostMac(mac: string): boolean {
  const m = mac.toLowerCase(); // normalizeMac returns uppercase
  if (m === "ffffffffffff") return true; // broadcast
  if (m === "000000000000") return true; // null / unresolved
  // The low bit of the first octet is the I/G (individual/group) bit; set means
  // multicast, which covers 01:00:5e (IPv4) and 33:33 (IPv6) without listing them.
  return (parseInt(m.slice(0, 2), 16) & 1) === 1;
}

/** Read the system ARP cache: ip -> mac. Works even without root. */
async function readArpTable(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { stdout } = await pexec("arp", ["-an"], { maxBuffer: 4 * 1024 * 1024 });
    // Format: ? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
    for (const line of stdout.split("\n")) {
      const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]+)/);
      if (!m) continue;
      const ip = m[1];
      const mac = normalizeMac(m[2]);
      if (mac && !isNonHostMac(mac)) map.set(ip, formatMac(mac));
    }
  } catch {
    /* arp cache read failed - return what we have */
  }
  return map;
}

async function reverseDns(ip: string): Promise<string | null> {
  try {
    // dns.reverse has no built-in timeout and can hang on hosts with no PTR;
    // cap it so a few slow lookups can't stretch out the whole scan.
    // The timeout handle must be cleared when the lookup wins, or every
    // resolved host leaves a live 2s timer holding its closure - up to one per
    // host, per scan.
    let timer: NodeJS.Timeout | undefined;
    try {
      const names = await Promise.race([
        dns.reverse(ip),
        new Promise<string[]>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 2000);
        }),
      ]);
      return names[0]?.replace(/\.$/, "") ?? null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Stable device id for a host, matching how the DB keys devices (mac > ip). */
function deviceIdFor(ip: string, mac: string | null): string {
  return mac ? mac : `ip:${ip}`;
}

/** Raised when the active interface isn't a LAN we can meaningfully scan. */
export class NotOnLanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotOnLanError";
  }
}

/**
 * Is the default route something other than a real LAN?
 *
 * A full-tunnel VPN takes the default route and reports a /32 on a `utun`
 * interface. Scanning that finds exactly one address - so every device would be
 * marked offline, writing an offline event for your whole inventory, then an
 * online event for all of them when the VPN drops. Refusing to scan is the
 * honest answer: we genuinely cannot see the LAN from here.
 */
export function lanUnusableReason(net: NetInfo): string | null {
  if (/^(utun|ppp|ipsec|tun|tap)/i.test(net.iface)) {
    return `interface ${net.iface} looks like a VPN tunnel`;
  }
  if (net.netmaskBits >= 30) {
    return `subnet ${net.cidr} is too small to be a LAN`;
  }
  return null;
}

/**
 * Full network scan: discover live hosts and enrich each with mac/vendor/hostname.
 *
 * `knownNames` maps device-id → previously-resolved hostname. Any host we've
 * already named is skipped during enrichment, so a steady-state scan does zero
 * mDNS/reverse-DNS work - only genuinely new or still-unnamed hosts pay that
 * cost. This keeps repeated background scans cheap on CPU and network.
 */
export interface ScanOptions {
  /** device-id -> hostname we've already resolved; skips re-lookup. */
  knownNames?: Map<string, string>;
  /** device-id -> OS family we've already guessed; skips the TTL ping. */
  knownOs?: Map<string, string>;
  /**
   * Device-ids we've already tried and failed to name. Retried only on a
   * periodic refresh, where the scanner passes an empty set.
   *
   * Without this, every unnameable device (11 of 21 on a real network - IoT gear
   * that answers no naming protocol at all) re-ran mDNS + NetBIOS + reverse DNS
   * on every single scan. Those have fixed multi-second timeouts, so they, not
   * the sweep, dominated scan time. A device that has no name now will still
   * have no name in five minutes.
   */
  triedUnnamed?: Set<string>;
}

export async function scanNetwork(opts: ScanOptions = {}): Promise<ScanResult> {
  const { knownNames, knownOs, triedUnnamed } = opts;
  const startedAt = Date.now();
  const net = await detectNetwork();

  // Bail before touching the DB rather than reporting an empty network.
  const unusable = lanUnusableReason(net);
  if (unusable) throw new NotOnLanError(`Skipping scan: ${unusable}`);

  const { ttls, arp } = await sweepSubnet(net, (ip, mac) =>
    Boolean(knownOs?.get(deviceIdFor(ip, mac))),
  );
  if (!ttls.has(net.ip)) ttls.set(net.ip, 0); // always include ourselves
  if (net.gateway && !ttls.has(net.gateway)) ttls.set(net.gateway, null);

  const liveIps = [...ttls.keys()];
  // Only hosts without a fresh cached name need enrichment. The scanner decides
  // freshness (unknown hosts and periodic refreshes are absent from knownNames),
  // so steady-state scans skip the network lookups entirely.
  const needIps = liveIps.filter((ip) => {
    const id = deviceIdFor(ip, arp.get(ip) ?? null);
    if (knownNames?.get(id)) return false; // already named
    if (triedUnnamed?.has(id)) return false; // asked before, it has no name
    return true;
  });
  // Enrich the hosts that need a name from several sources, in parallel:
  //  - service browse -> friendly names set on Chromecast/Nest, Apple TV,
  //    HomeKit, Sonos, printers ("Living Room display", "Bedroom Apple TV")
  //  - reverse PTR    -> a device's ".local" hostname
  //  - NetBIOS        -> machine names for Windows / NAS / Samba hosts
  // Reverse DNS is the final per-host fallback below. When nothing needs a name
  // this whole block is skipped.
  let mdnsNames = new Map<string, string>();
  let serviceNames = new Map<string, ServiceName>();
  let netbiosNames = new Map<string, string>();
  if (needIps.length > 0) {
    [mdnsNames, serviceNames, netbiosNames] = await Promise.all([
      mdnsReverseBatch(needIps),
      mdnsServiceBatch(),
      netbiosBatch(needIps),
    ]);
  }

  const hosts: DiscoveredHost[] = await Promise.all(
    liveIps.map(async (ip): Promise<DiscoveredHost> => {
      const mac = arp.get(ip) ?? null;
      const macNorm = mac ? normalizeMac(mac) : null;
      // Reuse a fresh cached name if we have one; otherwise take the best
      // available: friendly service name > .local hostname > NetBIOS > rDNS.
      const id = deviceIdFor(ip, mac);
      const cached = knownNames?.get(id);
      // reverseDns is the per-host fallback, but only for hosts we actually
      // tried to enrich this round - otherwise it reintroduces a DNS lookup
      // per unnameable device on every scan, which is what we just removed.
      const hostname =
        cached ??
        serviceNames.get(ip)?.name ??
        mdnsNames.get(ip) ??
        netbiosNames.get(ip) ??
        (triedUnnamed?.has(id) ? null : await reverseDns(ip));
      return {
        ip,
        mac,
        vendor: mac ? lookupVendor(mac) : null,
        hostname,
        osGuess: osGuessFromTtl(ttls.get(ip) ?? null),
        randomizedMac: macNorm ? isRandomizedMac(macNorm) : false,
      };
    })
  );

  hosts.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  const finishedAt = Date.now();
  return { net, startedAt, finishedAt, durationMs: finishedAt - startedAt, hosts };
}

export function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/**
 * Is `ip` within the given interface's subnet?
 *
 * `&` yields a SIGNED int32, so both sides must be coerced unsigned - and the
 * coercion must be parenthesized, because `>>>` binds tighter than `===`.
 * Written as `a & mask === b & mask >>> 0`, only the right side is unsigned, so
 * any network whose first octet is >= 128 (192.168.x, 172.16.x - i.e. most home
 * networks) never matches, and ARP-known hosts that don't answer ICMP silently
 * vanish from the scan. portscan.ts:assertInSubnet has the same computation.
 */
/**
 * Is this the subnet's network address or its broadcast address?
 *
 * Neither is a host. `hostsInSubnet` already skips them when sweeping, but the
 * ARP fold-in comes straight from the kernel's cache, which does hold entries
 * for them - that's how ff:ff:ff:ff:ff:ff at 192.168.4.0 became a "new device".
 */
export function isNetworkOrBroadcast(ip: string, net: NetInfo): boolean {
  if (net.netmaskBits >= 31) return false; // /31 and /32 have no reserved pair
  const mask = net.netmaskBits === 0 ? 0 : (0xffffffff << (32 - net.netmaskBits)) >>> 0;
  const addr = ipToInt(ip);
  const base = (ipToInt(net.ip) & mask) >>> 0;
  const broadcast = (base | (~mask >>> 0)) >>> 0;
  return addr === base || addr === broadcast;
}

export function inSubnet(ip: string, net: NetInfo): boolean {
  const mask = net.netmaskBits === 0 ? 0 : (0xffffffff << (32 - net.netmaskBits)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(net.ip) & mask) >>> 0);
}
