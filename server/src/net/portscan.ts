import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectNetwork } from "./subnet.js";

const pexec = promisify(execFile);

/**
 * Opt-in port / service scan of a SINGLE host via nmap -sV.
 *
 * Reverse-mDNS and MAC vendor give a device's identity; a service scan tells
 * you what it's actually *exposing* - open ports, running services, and risky
 * surfaces (Telnet, SMB, RDP, VNC) worth knowing about on your own LAN. This
 * is deliberately per-device and on-demand: nmap -sV is slow and noisy, so we
 * never run it automatically across the whole subnet.
 */

export interface OpenPort {
  port: number;
  proto: string;
  service: string | null;
  product: string | null; // -sV product + version, when detected
  /**
   * True when `service` is only nmap's port-number lookup, not something it
   * actually identified on the wire.
   *
   * This matters more than it sounds. nmap prints the historical registered
   * name for a port whether or not anything confirmed it - so an eero serving
   * TLS on 3001 comes back as "ssl/nessus", because 3001 was Nessus's port in
   * the 2000s. Rendering that identically to a real detection tells you a
   * vulnerability scanner is running on your router. It isn't.
   */
  guessed: boolean;
  risk: string | null; // note if this exposure is worth attention
}

export interface PortScanResult {
  available: boolean; // is nmap installed
  scanned: boolean; // did nmap actually complete a scan (vs. an error/skip)
  ip: string;
  scannedAt: number;
  durationMs: number;
  ports: OpenPort[];
  risks: string[]; // de-duplicated risk notes across all open ports
  message: string | null; // install hint, "host down", etc.
}

/** Is nmap on PATH? */
/**
 * Memoized: this spawned an `nmap --version` subprocess on every single port
 * scan, including each auto-scan of a new device. nmap doesn't get installed
 * or uninstalled while we're running, and if it does, a restart picks it up.
 */
let nmapPresent: Promise<boolean> | null = null;
export async function nmapAvailable(): Promise<boolean> {
  nmapPresent ??= pexec("nmap", ["--version"], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  return nmapPresent;
}

/**
 * Data stores that have no business listening on a home LAN - most ship with
 * no authentication by default, so an open port is effectively open data.
 */
const DATA_STORES: Record<number, string> = {
  1433: "MSSQL",
  3306: "MySQL",
  5432: "PostgreSQL",
  6379: "Redis",
  9200: "Elasticsearch",
  11211: "Memcached",
  27017: "MongoDB",
};

/**
 * Flag genuinely risky exposures. Returns a human note, or null if benign.
 * Deliberately conservative: ports that are normal for consumer gear (HTTP,
 * IPP, Chromecast's 8008/8009/8443) are NOT flagged, so a badge means something.
 */
export function riskFor(port: number, service: string | null): string | null {
  const s = (service ?? "").toLowerCase();

  // --- remote access ---
  if (port === 23 || port === 2323 || s.includes("telnet"))
    return "Telnet - unencrypted remote login, should not be open";
  if (port === 3389 || s.includes("ms-wbt") || s.includes("rdp")) return "Remote Desktop (RDP) exposed";
  if (port === 5900 || s.includes("vnc")) return "VNC remote desktop exposed";
  if (port === 5555 || s.includes("adb")) return "Android Debug Bridge (adb) exposed";
  if (port === 2375 || port === 2376 || s.includes("docker"))
    return "Docker API exposed - commonly unauthenticated root access";

  // --- file sharing / transfer ---
  if (port === 445 || port === 139 || s.includes("smb") || s.includes("microsoft-ds") || s.includes("netbios"))
    return "SMB/Windows file sharing exposed";
  if (port === 21 || s === "ftp") return "FTP - often unencrypted or anonymous";
  if (port === 69 || s === "tftp") return "TFTP - unauthenticated file transfer";
  if (port === 873 || s.includes("rsync")) return "rsync daemon exposed";
  if (port === 2049 || port === 111 || s.includes("nfs") || s.includes("rpcbind"))
    return "NFS/rpcbind exposed - network file shares";

  // --- printing (unauthenticated by design) ---
  if (port === 9100 || s.includes("jetdirect"))
    return "Raw printing (JetDirect) - unauthenticated printing and job access";
  if (port === 515 || s === "printer") return "LPD printing - legacy and unauthenticated";

  // --- IoT / management ---
  if (port === 1900 || s.includes("upnp")) return "UPnP exposed - a common IoT attack surface";
  if (port === 161 || port === 162 || s.includes("snmp"))
    return "SNMP exposed - frequently left on default community strings";
  if (port === 1883 || port === 8883 || s.includes("mqtt"))
    return "MQTT broker exposed - IoT control messages";
  if (port === 37777 || port === 554 || s.includes("rtsp")) return "Camera/RTSP stream exposed";

  // --- data stores ---
  if (DATA_STORES[port]) return `${DATA_STORES[port]} database exposed on the LAN`;

  return null;
}

const IN_SUBNET_ERR = "Refusing to scan an address outside your local subnet";

function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** Only ever scan addresses on our own LAN. */
async function assertInSubnet(ip: string): Promise<void> {
  const net = await detectNetwork();
  const bits = net.netmaskBits;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  // `&` yields a signed 32-bit int; coerce both sides unsigned before compare.
  const target = (ipToInt(ip) & mask) >>> 0;
  const ours = (ipToInt(net.ip) & mask) >>> 0;
  if (target !== ours) {
    throw new Error(IN_SUBNET_ERR);
  }
}

/** Parse nmap -sV normal output into open-port rows. */
export function parsePorts(stdout: string): OpenPort[] {
  const ports: OpenPort[] = [];
  for (const line of stdout.split("\n")) {
    // e.g. "22/tcp   open  ssh     OpenSSH 9.0 (protocol 2.0)"
    const m = line.match(/^(\d+)\/(tcp|udp)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const state = m[3].toLowerCase();
    if (!state.startsWith("open")) continue; // skip closed / filtered
    const port = Number(m[1]);
    const raw = m[4] ?? "";
    const marked = /\?+$/.test(raw); // nmap's own "I'm guessing" marker
    const svcRaw = raw.replace(/\?+$/, "");
    const service = svcRaw && svcRaw !== "unknown" ? svcRaw : null;
    const product = m[5]?.trim() || null;
    // No version banner and no confirmation means the name came from the port
    // table. The discovery pass runs without -sV at all, so everything it
    // reports is a guess until the version pass confirms it.
    const guessed = service !== null && (marked || product === null);
    ports.push({
      port,
      proto: m[2],
      service,
      product,
      guessed,
      // Never let a guessed NAME raise an alarm - port-based rules still apply,
      // so a genuinely risky port is still flagged on its number alone.
      risk: riskFor(port, guessed ? null : service),
    });
  }
  return ports;
}

/**
 * Run an opt-in service scan against one in-subnet host.
 * Never throws for scan failures; returns a result with a `message` instead.
 */
export async function portScan(ip: string): Promise<PortScanResult> {
  const scannedAt = Date.now();
  const base: Omit<PortScanResult, "ports" | "risks" | "durationMs"> = {
    available: true,
    scanned: false,
    ip,
    scannedAt,
    message: null,
  };

  if (!(await nmapAvailable())) {
    return {
      ...base,
      available: false,
      durationMs: Date.now() - scannedAt,
      ports: [],
      risks: [],
      message: "nmap is not installed - run: brew install nmap",
    };
  }

  try {
    await assertInSubnet(ip);
  } catch (err) {
    return {
      ...base,
      durationMs: Date.now() - scannedAt,
      ports: [],
      risks: [],
      message: (err as Error).message,
    };
  }

  const maxBuffer = 8 * 1024 * 1024;
  try {
    // Phase 1 (always): fast discovery of open ports across the top 200. No
    // -sV, so it's quick even on filtered hosts. nmap's output already carries
    // the well-known service name per port, which is enough to flag risks.
    // -Pn skips ping since the host is already known live from our inventory.
    const { stdout: disco } = await pexec(
      "nmap",
      ["-T4", "-Pn", "--open", "--top-ports", "200", "--max-retries", "2", ip],
      { timeout: 60_000, maxBuffer }
    );
    let ports = parsePorts(disco);
    if (ports.length === 0) {
      return {
        ...base,
        scanned: true,
        durationMs: Date.now() - scannedAt,
        ports: [],
        risks: [],
        message: "No open ports found in the top 200",
      };
    }

    // Phase 2 (best-effort): enrich with product/version on just the open
    // ports. Some services (printer jetdirect/LPD, IoT) never answer version
    // probes and stall, so this is capped and non-fatal - on failure we keep
    // the fast phase-1 result rather than losing everything.
    try {
      const portList = ports.map((p) => p.port).join(",");
      const { stdout: ver } = await pexec(
        "nmap",
        ["-sV", "--version-light", "-Pn", "--max-retries", "1", "-p", portList, ip],
        { timeout: 45_000, maxBuffer }
      );
      const enriched = parsePorts(ver);
      if (enriched.length) ports = enriched;
    } catch {
      /* version probe stalled - keep the fast phase-1 ports */
    }

    const risks = [...new Set(ports.map((p) => p.risk).filter((r): r is string => !!r))];
    return { ...base, scanned: true, durationMs: Date.now() - scannedAt, ports, risks, message: null };
  } catch (err) {
    return {
      ...base,
      durationMs: Date.now() - scannedAt,
      ports: [],
      risks: [],
      message: `Scan failed: ${(err as Error).message}`,
    };
  }
}
