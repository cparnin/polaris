import { getMeta, setMeta } from "./db.js";
import { sendNtfy, type NtfyMessage } from "./notify.js";

/**
 * Retry queue for alerts whose push failed.
 *
 * The flakiest network moment is right when a device joins (or right after the
 * laptop wakes and reassociates) - exactly when the alert you most wanted is
 * being sent. Without this, that one failed POST loses the alert forever: the
 * device is already recorded, so it will never be "new" again. Failed sends
 * land here (in the meta table, so they survive restarts) and are retried at
 * the top of each later scan, with a cap on both queue depth and attempts so a
 * dead topic can't hoard stale alerts indefinitely.
 */
const KEY = "alertOutbox";
const MAX_QUEUED = 20;
const MAX_ATTEMPTS = 5;

export interface QueuedAlert {
  msg: NtfyMessage;
  /** Send attempts so far, counting the original failed one. */
  attempts: number;
  queuedAt: number;
}

export function readOutbox(): QueuedAlert[] {
  try {
    const raw = getMeta(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedAlert[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: QueuedAlert[]): void {
  setMeta(KEY, JSON.stringify(items));
}

/** Queue an alert whose send just failed. Oldest entries fall off past the cap. */
export function queueAlert(msg: NtfyMessage): void {
  const items = readOutbox();
  items.push({ msg, attempts: 1, queuedAt: Date.now() });
  writeOutbox(items.slice(-MAX_QUEUED));
}

/**
 * Retry everything queued, dropping messages that succeed or exhaust their
 * attempts. `send` is injectable for tests; defaults to the real ntfy send.
 */
export async function drainOutbox(
  send: (m: NtfyMessage) => Promise<boolean> = sendNtfy
): Promise<void> {
  const items = readOutbox();
  if (items.length === 0) return;
  const remaining: QueuedAlert[] = [];
  for (const item of items) {
    if (await send(item.msg)) continue;
    item.attempts += 1;
    if (item.attempts < MAX_ATTEMPTS) remaining.push(item);
    else console.error(`[ntfy] dropping queued alert after ${item.attempts} attempts: ${item.msg.title}`);
  }
  writeOutbox(remaining);
}
