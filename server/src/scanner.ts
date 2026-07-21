import { EventEmitter } from "node:events";
import { scanNetwork, type ScanResult } from "./net/discover.js";
import {
  applyScan,
  listDevices,
  getDeviceById,
  pruneEvents,
  savePortScan,
  type SeenDevice,
  type ScanDiff,
} from "./db.js";
import { portScan, type PortScanResult } from "./net/portscan.js";
import { notifyNewDevice, isNtfyConfigured } from "./notify.js";

export interface ScanSummary {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cidr: string;
  iface: string;
  hostCount: number;
  diff: ScanDiff;
}

/** Emits: "scan:start", "scan:done" (ScanSummary), "scan:error" (Error). */
export const scanBus = new EventEmitter();
// Each open dashboard tab subscribes 4 listeners, so the default cap of 10
// warns at 3 tabs. These are all deliberate and cleaned up on disconnect.
scanBus.setMaxListeners(0);

// Auto-fingerprint devices the moment they appear. Off via
// AUTOSCAN_NEW_DEVICES=0; capped so a burst of arrivals can't queue a long
// train of nmap runs.
const AUTOSCAN_NEW = process.env.AUTOSCAN_NEW_DEVICES !== "0";
const AUTOSCAN_MAX = Math.max(0, Number(process.env.AUTOSCAN_MAX_PER_SCAN ?? 3) || 0);

/**
 * For each newly-seen device: port-scan it (up to AUTOSCAN_MAX per scan),
 * persist the result so the map badges it immediately, then push an alert that
 * says what the device is exposing. Best-effort - never throws into the caller.
 */
async function handleNewDevices(ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    const dev = getDeviceById(id);
    if (!dev) continue;

    let scan: PortScanResult | null = null;
    if (AUTOSCAN_NEW && dev.ip && i < AUTOSCAN_MAX) {
      try {
        scan = await portScan(dev.ip);
        if (scan.scanned) {
          savePortScan(dev.id, scan.ports, scan.risks.length, scan.scannedAt);
        }
      } catch (err) {
        console.error(`[autoscan] ${dev.ip} failed:`, (err as Error).message);
        scan = null;
      }
    }

    if (isNtfyConfigured() && guestModeRemaining() === 0) {
      await notifyNewDevice(dev, scan).catch((e: Error) =>
        console.error("[notify] new-device push failed:", e.message)
      );
    }
  }
}

let scanning = false;
let paused = false;
/**
 * Guest mode: keep discovering and recording, just stop pushing new-device
 * alerts until this timestamp.
 *
 * Per-device allowlisting can't solve this. Modern phones use randomized MACs
 * that rotate per network and per visit, so the friend whose phone you approved
 * last month arrives as a brand-new device today - there is no stable identity
 * to remember. Muting for an evening is honest about that: nothing is
 * suppressed permanently, nothing is silently trusted, and the devices still
 * appear on the dashboard and in history.
 */
let guestUntil = 0;
let lastSummary: ScanSummary | null = null;
let scanCount = 0;

export function isPaused(): boolean {
  return paused;
}

/** Milliseconds of guest mode remaining, 0 when off. */
export function guestModeRemaining(): number {
  return Math.max(0, guestUntil - Date.now());
}

/** Mute new-device pushes for `hours` (0 turns it off). Returns the deadline. */
export function setGuestMode(hours: number): number {
  guestUntil = hours > 0 ? Date.now() + hours * 3_600_000 : 0;
  scanBus.emit("guest:changed", { until: guestUntil });
  return guestUntil;
}

/** Pause/resume the auto-scan loop. Pure: flips the flag and announces it. */
export function setPaused(value: boolean): void {
  paused = value;
  scanBus.emit("scan:paused", { paused });
}

// Every Nth scan, re-resolve *every* device's name from the network instead of
// trusting the cache - so renamed devices and names that were unresolvable the
// first time get picked up. Unknown hosts are always re-resolved regardless.
const NAME_REFRESH_EVERY = Math.max(1, Number(process.env.NAME_REFRESH_EVERY ?? 6));

export function isScanning(): boolean {
  return scanning;
}
export function getLastSummary(): ScanSummary | null {
  return lastSummary;
}

function toSeen(result: ScanResult): SeenDevice[] {
  return result.hosts.map((h) => {
    const id = h.mac ? h.mac : `ip:${h.ip}`;
    return {
      id,
      mac: h.mac,
      ip: h.ip,
      hostname: h.hostname,
      vendor: h.vendor,
      os_guess: h.osGuess,
      is_gateway: h.ip === result.net.gateway,
      is_self: h.ip === result.net.ip,
      randomized: h.randomizedMac,
    };
  });
}

/** Run one scan, persist results, emit events. Guards against concurrent runs. */
export async function runScan(): Promise<ScanSummary> {
  if (scanning) {
    throw new Error("A scan is already in progress");
  }
  scanning = true;
  scanBus.emit("scan:start", { at: Date.now() });
  try {
    // If the DB is empty this is the very first scan - treat everything as a
    // baseline and don't fire a notification storm for pre-existing devices.
    const priorDevices = listDevices();
    const isBaseline = priorDevices.length === 0;

    // Feed already-resolved names back in so most scans skip the mDNS/NetBIOS/DNS
    // lookups for hosts we've already identified - background scans stay cheap.
    // On a refresh scan we pass nothing, forcing a fresh resolve of everyone.
    const refreshNames = scanCount % NAME_REFRESH_EVERY === 0;
    scanCount++;
    const knownNames = new Map<string, string>();
    if (!refreshNames) {
      for (const d of priorDevices) {
        if (d.hostname) knownNames.set(d.id, d.hostname);
      }
    }
    // A device's OS family doesn't change, so once we've guessed it we never
    // need to ping that host again - which is the only reason we still ping.
    const knownOs = new Map<string, string>();
    for (const d of priorDevices) {
      if (d.os_guess) knownOs.set(d.id, d.os_guess);
    }
    // Devices we've already failed to name. Empty on a refresh scan, so they do
    // get retried periodically - just not every five minutes forever.
    const triedUnnamed = new Set<string>();
    if (!refreshNames) {
      for (const d of priorDevices) {
        if (!d.hostname) triedUnnamed.add(d.id);
      }
    }

    const result = await scanNetwork({ knownNames, knownOs, triedUnnamed });
    const now = result.finishedAt;
    const diff = applyScan(toSeen(result), now);
    pruneEvents(); // keep the activity log (and the SQLite WAL) bounded

    // A device joining is exactly when you want to know what it exposes, so
    // fingerprint new arrivals and fold the findings into the alert. Runs
    // detached: nmap takes tens of seconds and must not stall the scan loop.
    // Skipped on the baseline scan, where every device is "new".
    if (!isBaseline && diff.newDevices.length) {
      void handleNewDevices(diff.newDevices);
    }
    const summary: ScanSummary = {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      cidr: result.net.cidr,
      iface: result.net.iface,
      hostCount: result.hosts.length,
      diff,
    };
    lastSummary = summary;
    scanBus.emit("scan:done", summary);
    return summary;
  } catch (err) {
    scanBus.emit("scan:error", err);
    throw err;
  } finally {
    scanning = false;
  }
}

/**
 * Log a failed scan, quietly when it's an expected condition.
 *
 * Being on a VPN isn't an error - it's a normal state where we can't see the
 * LAN. Logging it as a failure every 5 minutes would train you to ignore the
 * log, which is where the real failures show up.
 */
function logScanFailure(kind: string, err: Error): void {
  if (err.name === "NotOnLanError") {
    console.log(`[scan] ${err.message}`);
    return;
  }
  console.error(`[scan] ${kind} scan failed:`, err.message);
}

let timer: NodeJS.Timeout | null = null;

/** Start periodic scanning every `intervalMs`, running one immediately. */
export function startAutoScan(intervalMs: number): void {
  if (timer) clearInterval(timer);
  void runScan().catch((e) => logScanFailure("initial", e));
  timer = setInterval(() => {
    if (!scanning && !paused) {
      void runScan().catch((e) => logScanFailure("periodic", e));
    }
  }, intervalMs);
}

/** Stop periodic scanning (shutdown). Safe to call when not running. */
export function stopAutoScan(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
