import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import { detectNetwork, networkBase, type NetInfo } from "./subnet.js";
import { normalizeMac, formatMac, lookupVendor, isRandomizedMac } from "./vendors.js";
import { mdnsReverseBatch, mdnsServiceBatch } from "./mdns.js";

const pexec = promisify(execFile);

/** Max hosts to ping-sweep. Guards against someone pointing this at a /16. */
const MAX_SWEEP_HOSTS = 4096;
/** How many concurrent ping processes to keep in flight. */
const PING_CONCURRENCY = 256;

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
 * Fast parallel ICMP ping-sweep. Finds hosts that answer ICMP and, as a side
 * effect, populates the system ARP cache so we can read MACs for everything
 * that responded (including hosts discovered via other recent traffic).
 * Runs unprivileged and completes a /24 in ~2s, a /22 in ~10s.
 */
async function pingSweep(net: NetInfo): Promise<Map<string, number | null>> {
  const ips = hostsInSubnet(net);
  const live = new Map<string, number | null>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < ips.length) {
      const ip = ips[cursor++];
      const ttl = await pingOne(ip);
      if (ttl !== null) live.set(ip, ttl);
    }
  }

  const workers = Array.from({ length: Math.min(PING_CONCURRENCY, ips.length) }, worker);
  await Promise.all(workers);
  return live;
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
      if (mac) map.set(ip, formatMac(mac));
    }
  } catch {
    /* arp cache read failed — return what we have */
  }
  return map;
}

async function reverseDns(ip: string): Promise<string | null> {
  try {
    const names = await dns.reverse(ip);
    return names[0]?.replace(/\.$/, "") ?? null;
  } catch {
    return null;
  }
}

/** Full network scan: discover live hosts and enrich each with mac/vendor/hostname. */
export async function scanNetwork(): Promise<ScanResult> {
  const startedAt = Date.now();
  const net = await detectNetwork();

  const ttls = await pingSweep(net);
  if (!ttls.has(net.ip)) ttls.set(net.ip, 0); // always include ourselves
  if (net.gateway && !ttls.has(net.gateway)) ttls.set(net.gateway, null);

  const arp = await readArpTable();
  // Include hosts present in the ARP cache (seen via recent traffic) even if
  // they didn't answer our ICMP ping — as long as they're in our subnet.
  for (const ip of arp.keys()) {
    if (inSubnet(ip, net) && !ttls.has(ip)) ttls.set(ip, null);
  }

  const liveIps = [...ttls.keys()];
  // Enrich names via mDNS (best-effort, batched, run in parallel):
  //  - reverse PTR  -> a device's ".local" hostname
  //  - service browse -> friendly names set on Chromecast/Nest, Apple TV,
  //    HomeKit, Sonos, printers ("Living Room display", "Bedroom Apple TV").
  const [mdnsNames, serviceNames] = await Promise.all([
    mdnsReverseBatch(liveIps),
    mdnsServiceBatch(),
  ]);

  const hosts: DiscoveredHost[] = await Promise.all(
    liveIps.map(async (ip): Promise<DiscoveredHost> => {
      const mac = arp.get(ip) ?? null;
      const macNorm = mac ? normalizeMac(mac) : null;
      // Prefer a friendly service name, then the .local hostname, then rDNS.
      const hostname =
        serviceNames.get(ip)?.name ?? mdnsNames.get(ip) ?? (await reverseDns(ip));
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

function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** Is `ip` within the given interface's subnet? */
function inSubnet(ip: string, net: NetInfo): boolean {
  const mask = net.netmaskBits === 0 ? 0 : (0xffffffff << (32 - net.netmaskBits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net.ip) & mask) >>> 0;
}
