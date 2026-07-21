import dgram from "node:dgram";

/**
 * NetBIOS node-status name resolver (UDP 137).
 *
 * Windows PCs, NAS boxes, and anything running Samba answer a NetBIOS
 * node-status query with their machine name - even when they stay silent on
 * mDNS and have no reverse DNS. This is often the *only* way to put a real
 * name on an otherwise-generic "Vendor · .x" device. We hand-roll the packet
 * (same approach as our mDNS resolver) to avoid a native dependency.
 */

const NB_PORT = 137;

/** The wildcard NetBIOS name "*" in first-level (nibble) encoding: 34 bytes. */
export function encodeWildcardName(): Buffer {
  const out = Buffer.alloc(34);
  out[0] = 0x20; // encoded length (32)
  const name = Buffer.alloc(16, 0);
  name[0] = 0x2a; // "*"
  for (let i = 0; i < 16; i++) {
    out[1 + i * 2] = 0x41 + (name[i] >> 4); // high nibble -> 'A'..'P'
    out[1 + i * 2 + 1] = 0x41 + (name[i] & 0x0f); // low nibble
  }
  out[33] = 0x00; // root terminator
  return out;
}

/** A node-status request: header + wildcard question, NBSTAT/IN. */
function encodeNodeStatusQuery(): Buffer {
  // txid(0) flags(0) qd(1) an(0) ns(0) ar(0)
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const tail = Buffer.from([0x00, 0x21, 0x00, 0x01]); // QTYPE NBSTAT, QCLASS IN
  return Buffer.concat([header, encodeWildcardName(), tail]);
}

/** Skip an encoded name (length-prefixed labels or a compression pointer). */
function skipName(buf: Buffer, offset: number): number {
  let pos = offset;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) return pos + 1;
    if ((len & 0xc0) === 0xc0) return pos + 2; // pointer
    pos += 1 + len;
  }
  return pos;
}

/** Pull the unique machine name (suffix 0x00, not a group) from a response. */
export function parseNodeStatus(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  if (an < 1) return null;

  let pos = 12;
  for (let i = 0; i < qd; i++) pos = skipName(buf, pos) + 4; // + qtype/qclass
  pos = skipName(buf, pos);
  pos += 2 + 2 + 4; // type + class + ttl
  if (pos + 3 > buf.length) return null;
  pos += 2; // rdlength
  const numNames = buf[pos];
  pos += 1;

  for (let i = 0; i < numNames && pos + 18 <= buf.length; i++) {
    const raw = buf.toString("ascii", pos, pos + 15).replace(/\0/g, "").trim();
    const suffix = buf[pos + 15];
    const flags = buf.readUInt16BE(pos + 16);
    pos += 18;
    const isGroup = (flags & 0x8000) !== 0;
    // Suffix 0x00 + unique = the workstation/computer name (what we want).
    if (suffix === 0x00 && !isGroup && raw && raw !== "*") return raw;
  }
  return null;
}

/**
 * Resolve NetBIOS machine names for a batch of IPs. Best-effort: hosts that
 * don't run NetBIOS simply never reply and are absent from the result.
 */
export async function netbiosBatch(
  ips: string[],
  timeoutMs = 1500
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
      if (result.has(rinfo.address)) return;
      try {
        const name = parseNodeStatus(msg);
        if (name) result.set(rinfo.address, name);
      } catch {
        /* malformed packet - ignore */
      }
    });
    sock.on("error", finish);

    sock.bind(0, () => {
      const query = encodeNodeStatusQuery();
      for (const ip of ips) {
        try {
          sock.send(query, NB_PORT, ip);
        } catch {
          /* unreachable host - skip */
        }
      }
    });

    setTimeout(finish, timeoutMs);
  });
}
