import Database from "better-sqlite3";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.POLARIS_DATA_DIR ?? join(here, "..", "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "polaris.sqlite");
// One-time rename from an earlier filename so existing device history carries
// over across rebrands instead of starting from an empty database. Tries each
// prior name in order (newest first): iris.sqlite → cap-network.sqlite.
const LEGACY_DBS = ["iris.sqlite", "cap-network.sqlite"];
if (!existsSync(DB_PATH)) {
  const legacy = LEGACY_DBS.map((n) => join(DATA_DIR, n)).find((p) => existsSync(p));
  if (legacy) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        renameSync(legacy + suffix, DB_PATH + suffix);
      } catch {
        /* WAL/SHM may be absent — the main file is what matters */
      }
    }
  }
}

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,   -- mac (preferred) or "ip:<addr>" fallback
    mac         TEXT,
    ip          TEXT,
    hostname    TEXT,
    vendor      TEXT,
    os_guess    TEXT,               -- coarse OS family from TTL
    label       TEXT,               -- user-assigned friendly name
    trusted     INTEGER NOT NULL DEFAULT 0,
    is_gateway  INTEGER NOT NULL DEFAULT 0,
    is_self     INTEGER NOT NULL DEFAULT 0,
    randomized  INTEGER NOT NULL DEFAULT 0,
    online      INTEGER NOT NULL DEFAULT 0,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    type       TEXT NOT NULL,       -- new_device | online | offline
    device_id  TEXT NOT NULL,
    detail     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
`);

// --- lightweight migrations (safe to run every boot) ---
function addColumnIfMissing(table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
addColumnIfMissing("devices", "os_guess", "TEXT");
// Persisted port-scan results, so the map can badge devices by exposure without
// re-running nmap on every load.
addColumnIfMissing("devices", "open_ports", "TEXT"); // JSON array of OpenPort
addColumnIfMissing("devices", "risk_count", "INTEGER");
addColumnIfMissing("devices", "last_portscan_at", "INTEGER");

export interface DeviceRow {
  id: string;
  mac: string | null;
  ip: string | null;
  hostname: string | null;
  vendor: string | null;
  os_guess: string | null;
  label: string | null;
  trusted: number;
  is_gateway: number;
  is_self: number;
  randomized: number;
  online: number;
  first_seen: number;
  last_seen: number;
  open_ports: string | null; // JSON array of OpenPort, or null if never scanned
  risk_count: number | null;
  last_portscan_at: number | null;
}

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  device_id: string;
  detail: string | null;
}

const getDevice = db.prepare<[string], DeviceRow>("SELECT * FROM devices WHERE id = ?");
const listDevicesStmt = db.prepare<[], DeviceRow>("SELECT * FROM devices ORDER BY last_seen DESC");
const insertEvent = db.prepare(
  "INSERT INTO events (ts, type, device_id, detail) VALUES (?, ?, ?, ?)"
);
const recentEventsStmt = db.prepare<[number], EventRow>(
  "SELECT * FROM events ORDER BY ts DESC LIMIT ?"
);

/**
 * Cap the activity log so the SQLite file can't grow without bound. The feed
 * only ever shows the most recent events, so we keep a rolling window and drop
 * the rest. Override with EVENT_RETENTION.
 */
const MAX_EVENTS = Number(process.env.EVENT_RETENTION ?? 5000);
const pruneEventsStmt = db.prepare(
  "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY ts DESC LIMIT ?)"
);

/** Trim the events table to the newest `keep` rows. Returns rows deleted. */
export function pruneEvents(keep = MAX_EVENTS): number {
  const deleted = pruneEventsStmt.run(keep).changes;
  // Fold the freed pages back into the main file so the WAL doesn't sit large.
  if (deleted > 0) db.pragma("wal_checkpoint(TRUNCATE)");
  return deleted;
}

export function listDevices(): DeviceRow[] {
  return listDevicesStmt.all();
}

export function getDeviceById(id: string): DeviceRow | undefined {
  return getDevice.get(id);
}

/** Friendly display name for a device: label > hostname > vendor + last octet. */
export function displayNameOf(d: DeviceRow): string {
  if (d.label) return d.label;
  if (d.hostname) return d.hostname;
  const tail = d.ip?.split(".").pop() ?? "?";
  if (d.vendor && !d.vendor.startsWith("Private")) return `${d.vendor} · .${tail}`;
  return `Unknown · .${tail}`;
}

export function recentEvents(limit = 100): EventRow[] {
  return recentEventsStmt.all(limit);
}

const setLabelStmt = db.prepare("UPDATE devices SET label = ? WHERE id = ?");
const setTrustedStmt = db.prepare("UPDATE devices SET trusted = ? WHERE id = ?");
const deleteDeviceStmt = db.prepare("DELETE FROM devices WHERE id = ?");

export function setLabel(id: string, label: string | null): void {
  setLabelStmt.run(label, id);
}

export function setTrusted(id: string, trusted: boolean): void {
  setTrustedStmt.run(trusted ? 1 : 0, id);
}

interface GhostDupe {
  ghost_id: string;
  ghost_label: string | null;
  ghost_trusted: number;
  real_id: string;
  real_label: string | null;
  real_trusted: number;
}

/** "ip:<addr>" rows that duplicate a MAC-keyed row holding the same address. */
const findGhostDuplicates = db.prepare<[], GhostDupe>(`
  SELECT g.id AS ghost_id, g.label AS ghost_label, g.trusted AS ghost_trusted,
         m.id AS real_id, m.label AS real_label, m.trusted AS real_trusted
  FROM devices g
  JOIN devices m ON m.ip = g.ip AND m.mac IS NOT NULL AND m.id <> g.id
  WHERE g.mac IS NULL AND g.id LIKE 'ip:%'
`);

const savePortScanStmt = db.prepare(
  "UPDATE devices SET open_ports = ?, risk_count = ?, last_portscan_at = ? WHERE id = ?"
);

const deleteEventsForDeviceStmt = db.prepare("DELETE FROM events WHERE device_id = ?");

/**
 * Permanently forget a device and its activity history. Useful for clearing
 * dead records — e.g. devices left over from a previous subnet that will never
 * be seen again. If the device is still on the network it'll simply reappear
 * on the next scan (as a new device).
 */
export function forgetDevice(id: string): boolean {
  deleteEventsForDeviceStmt.run(id);
  return deleteDeviceStmt.run(id).changes > 0;
}

/** Persist a device's latest port-scan so the map can show its exposure. */
export function savePortScan(
  id: string,
  ports: unknown[],
  riskCount: number,
  scannedAt: number
): void {
  savePortScanStmt.run(JSON.stringify(ports), riskCount, scannedAt, id);
}

const upsertDevice = db.prepare(`
  INSERT INTO devices (id, mac, ip, hostname, vendor, os_guess, trusted, is_gateway, is_self, randomized, online, first_seen, last_seen)
  VALUES (@id, @mac, @ip, @hostname, @vendor, @os_guess, 0, @is_gateway, @is_self, @randomized, 1, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    mac        = COALESCE(excluded.mac, devices.mac),
    ip         = excluded.ip,
    hostname   = COALESCE(excluded.hostname, devices.hostname),
    vendor     = COALESCE(excluded.vendor, devices.vendor),
    os_guess   = COALESCE(excluded.os_guess, devices.os_guess),
    is_gateway = excluded.is_gateway,
    is_self    = excluded.is_self,
    randomized = excluded.randomized,
    online     = 1,
    last_seen  = excluded.last_seen
`);

export interface SeenDevice {
  id: string;
  mac: string | null;
  ip: string;
  hostname: string | null;
  vendor: string | null;
  os_guess: string | null;
  is_gateway: boolean;
  is_self: boolean;
  randomized: boolean;
}

export interface ScanDiff {
  newDevices: string[];    // device ids seen for the first time
  cameOnline: string[];    // were offline, now online
  wentOffline: string[];   // were online, now absent
}

/**
 * Apply a scan's results transactionally: upsert everything seen, mark absent
 * devices offline, and record events for the transitions.
 */
export const applyScan = db.transaction((seen: SeenDevice[], now: number): ScanDiff => {
  const diff: ScanDiff = { newDevices: [], cameOnline: [], wentOffline: [] };
  const seenIds = new Set(seen.map((d) => d.id));

  for (const d of seen) {
    const prior = getDevice.get(d.id);
    upsertDevice.run({
      id: d.id,
      mac: d.mac,
      ip: d.ip,
      hostname: d.hostname,
      vendor: d.vendor,
      os_guess: d.os_guess,
      is_gateway: d.is_gateway ? 1 : 0,
      is_self: d.is_self ? 1 : 0,
      randomized: d.randomized ? 1 : 0,
      now,
    });
    if (!prior) {
      diff.newDevices.push(d.id);
      insertEvent.run(now, "new_device", d.id, JSON.stringify({ ip: d.ip, vendor: d.vendor }));
    } else if (prior.online === 0) {
      diff.cameOnline.push(d.id);
      insertEvent.run(now, "online", d.id, JSON.stringify({ ip: d.ip }));
    }
  }

  // Reap IP-keyed ghost duplicates. A device first seen before its MAC was in
  // the ARP cache gets an "ip:<addr>" row; once its MAC is known it gets a
  // proper MAC-keyed row, leaving the old one as a duplicate forever. Match on
  // IP across the whole table (not just this scan) so ghosts left behind on an
  // old subnet get cleaned up too. The user's label / trust flag is carried
  // over to the surviving MAC-keyed row first.
  for (const dupe of findGhostDuplicates.all()) {
    if (dupe.ghost_label && !dupe.real_label) setLabelStmt.run(dupe.ghost_label, dupe.real_id);
    if (dupe.ghost_trusted && !dupe.real_trusted) setTrustedStmt.run(1, dupe.real_id);
    deleteDeviceStmt.run(dupe.ghost_id);
    seenIds.delete(dupe.ghost_id); // don't also mark it offline below
  }

  // Anything currently online but not in this scan → mark offline.
  const online = db.prepare<[], DeviceRow>("SELECT * FROM devices WHERE online = 1").all();
  const markOffline = db.prepare("UPDATE devices SET online = 0 WHERE id = ?");
  for (const dev of online) {
    if (!seenIds.has(dev.id)) {
      markOffline.run(dev.id);
      diff.wentOffline.push(dev.id);
      insertEvent.run(now, "offline", dev.id, JSON.stringify({ ip: dev.ip }));
    }
  }

  return diff;
});
