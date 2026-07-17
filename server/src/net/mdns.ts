import dgram from "node:dgram";

/**
 * Minimal multicast-DNS reverse resolver.
 *
 * Many devices (Macs, iPhones, printers, Chromecast/Nest, Sonos, smart-home
 * gear) answer a reverse PTR query for their IP over mDNS with a friendly
 * ".local" hostname — e.g. "Chads-MacBook-Pro.local", "Living-Room-Nest.local".
 * Home routers rarely provide reverse DNS, so this is where real device names
 * come from. We hand-roll the DNS packet so we don't need a native dependency.
 */

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;

/** Encode a reverse-PTR mDNS query for one IPv4 address. */
function encodeReverseQuery(ip: string): Buffer {
  const labels = ip.split(".").reverse().concat(["in-addr", "arpa"]);
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // 1 question
  const parts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0])); // root label
  const qtype = Buffer.from([0, 12]); // PTR
  const qclass = Buffer.from([0x80, 0x01]); // QU bit (unicast response) + IN
  return Buffer.concat([header, ...parts, qtype, qclass]);
}

/** Decode a (possibly compressed) DNS name starting at `offset`. */
function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let guard = 0;
  while (guard++ < 128) {
    const len = buf[pos];
    if (len === 0) {
      if (next === -1) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next === -1) next = pos + 2;
      pos = ptr;
      continue;
    }
    labels.push(buf.toString("ascii", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join("."), next === -1 ? pos + 1 : next];
}

/** Extract the target name from the first PTR answer in a response. */
function parsePtrAnswer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const [, after] = readName(buf, pos);
    pos = after + 4; // qtype + qclass
  }
  for (let i = 0; i < an && pos < buf.length; i++) {
    const [, after] = readName(buf, pos);
    pos = after;
    const type = buf.readUInt16BE(pos);
    const rdlen = buf.readUInt16BE(pos + 8);
    pos += 10; // type(2) class(2) ttl(4) rdlength(2)
    if (type === 12) {
      const [name] = readName(buf, pos);
      return name;
    }
    pos += rdlen;
  }
  return null;
}

function cleanName(name: string): string {
  return name.replace(/\.local\.?$/i, "").replace(/\.$/, "").trim();
}

/* ===================================================================== *
 * mDNS SERVICE DISCOVERY
 *
 * Reverse-PTR gives a device's ".local" hostname, but the *nicest* names
 * live in service advertisements. A Nest Hub answers "_googlecast._tcp"
 * with a TXT record "fn=Living Room display"; an Apple TV answers
 * "_airplay._tcp" with its set name; a HomeKit plug answers "_hap._tcp"
 * with its accessory name and model. We browse a curated set of service
 * types and pull the friendly name (and model, when present) out of the
 * SRV/TXT/PTR records each device sends back.
 * ===================================================================== */

/** Service types worth browsing for friendly home-device names. */
const SERVICE_TYPES = [
  "_googlecast._tcp.local", // Chromecast, Nest Hub/Mini, Google TV
  "_airplay._tcp.local", // Apple TV, AirPlay speakers
  "_raop._tcp.local", // AirPlay audio (HomePod, receivers)
  "_hap._tcp.local", // HomeKit accessories
  "_spotify-connect._tcp.local", // Spotify-capable speakers
  "_sonos._tcp.local", // Sonos
  "_amzn-wplay._tcp.local", // Amazon Fire TV / some Echo
  "_ipp._tcp.local", // network printers (IPP)
  "_printer._tcp.local", // network printers (LPD)
];

/** Encode a set of DNS labels (no compression) into wire format. */
function encodeLabels(labels: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0])); // root label
  return Buffer.concat(parts);
}

/** Encode a PTR "browse" query for one service type (QU unicast-response bit). */
function encodeServiceQuery(serviceType: string): Buffer {
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // 1 question
  const name = encodeLabels(serviceType.split("."));
  const qtype = Buffer.from([0, 12]); // PTR
  const qclass = Buffer.from([0x80, 0x01]); // QU + IN
  return Buffer.concat([header, name, qtype, qclass]);
}

interface RawRecord {
  name: string;
  type: number;
  rdStart: number;
  rdLen: number;
}

/** Walk every resource record (answers + authority + additional) in a message. */
function walkRecords(buf: Buffer): RawRecord[] {
  const out: RawRecord[] = [];
  if (buf.length < 12) return out;
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const [, after] = readName(buf, pos);
    pos = after + 4; // qtype + qclass
  }
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const [name, after] = readName(buf, pos);
    pos = after;
    const type = buf.readUInt16BE(pos);
    const rdLen = buf.readUInt16BE(pos + 8);
    const rdStart = pos + 10; // type(2) class(2) ttl(4) rdlength(2)
    out.push({ name, type, rdStart, rdLen });
    pos = rdStart + rdLen;
  }
  return out;
}

/** Parse a TXT record's key=value pairs (lowercased keys). */
function parseTxt(buf: Buffer, start: number, len: number): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = start;
  const end = Math.min(start + len, buf.length);
  while (pos < end) {
    const l = buf[pos];
    pos += 1;
    if (l === 0 || pos + l > end) continue;
    const s = buf.toString("utf8", pos, pos + l);
    pos += l;
    const eq = s.indexOf("=");
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
  }
  return out;
}

/** Turn a service-instance name into a human label ("AABBCC@Den" -> "Den"). */
function instanceFriendly(instanceFull: string): string {
  let s = instanceFull.split(".")[0]; // first label = instance name
  const at = s.match(/^[0-9a-fA-F]{12}@(.+)$/); // _raop uses "MAC@Name"
  if (at) s = at[1];
  return s.trim();
}

export interface ServiceName {
  name: string;
  model: string | null;
}

/** Extract the best friendly name + model from one service response. */
function parseServiceResponse(buf: Buffer): ServiceName | null {
  let fn: string | null = null; // TXT-provided friendly name (best)
  let instance: string | null = null; // instance label (fallback)
  let model: string | null = null;
  for (const r of walkRecords(buf)) {
    if (r.type === 16) {
      // TXT
      const txt = parseTxt(buf, r.rdStart, r.rdLen);
      if (!fn && txt.fn) fn = txt.fn; // googlecast friendly name
      if (!model) model = txt.md || txt.am || txt.model || null;
      if (!instance) instance = instanceFriendly(r.name);
    } else if (r.type === 33) {
      // SRV — record name is the instance
      if (!instance) instance = instanceFriendly(r.name);
    } else if (r.type === 12) {
      // PTR — rdata target is the instance
      const [target] = readName(buf, r.rdStart);
      if (!instance && target.includes("._")) instance = instanceFriendly(target);
    }
  }
  const name = fn || instance;
  if (!name) return null;
  return { name: cleanName(name), model: model ? cleanName(model) : null };
}

/**
 * Browse mDNS service types and collect friendly names by device IP.
 * QU responses arrive unicast from each device's own address, so we key
 * on rinfo.address exactly like the reverse resolver.
 */
export async function mdnsServiceBatch(timeoutMs = 2500): Promise<Map<string, ServiceName>> {
  const result = new Map<string, ServiceName>();

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    sock.on("message", (msg, rinfo) => {
      try {
        const info = parseServiceResponse(msg);
        if (!info) return;
        const existing = result.get(rinfo.address);
        if (!existing) {
          result.set(rinfo.address, info);
        } else if (info.model && !existing.model) {
          existing.model = info.model; // enrich model from a later packet
        }
      } catch {
        /* malformed packet — ignore */
      }
    });
    sock.on("error", finish);

    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(255);
      } catch {
        /* not fatal */
      }
      for (const st of SERVICE_TYPES) {
        sock.send(encodeServiceQuery(st), MDNS_PORT, MDNS_ADDR);
      }
    });

    setTimeout(finish, timeoutMs);
  });
}

/**
 * Resolve friendly hostnames for a batch of IPs via reverse mDNS.
 * Best-effort: IPs that don't answer are simply absent from the result.
 */
export async function mdnsReverseBatch(
  ips: string[],
  timeoutMs = 2500
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (ips.length === 0) return result;

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    sock.on("message", (msg, rinfo) => {
      // Responses arrive unicast from the device's own IP (QU bit set).
      if (result.has(rinfo.address)) return;
      try {
        const name = parsePtrAnswer(msg);
        if (name) result.set(rinfo.address, cleanName(name));
      } catch {
        /* malformed packet — ignore */
      }
    });
    sock.on("error", finish);

    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(255);
      } catch {
        /* not fatal */
      }
      for (const ip of ips) {
        const q = encodeReverseQuery(ip);
        sock.send(q, MDNS_PORT, MDNS_ADDR);
      }
    });

    setTimeout(finish, timeoutMs);
  });
}
