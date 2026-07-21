import type { DeviceRow } from "./db.js";
import { displayNameOf } from "./db.js";
import type { PortScanResult } from "./net/portscan.js";

/**
 * ntfy push notifications. Configure via environment:
 *   NTFY_URL       full topic URL, e.g. https://ntfy.sh/polaris-home-abc123
 *                  (use a long, unguessable topic — anyone who knows it can read it)
 *   NTFY_TOKEN     optional access token for protected/self-hosted servers
 *   NTFY_PRIORITY  optional default priority (min|low|default|high|urgent)
 *
 * If NTFY_URL is unset, notifications are silently disabled.
 */
const NTFY_URL = process.env.NTFY_URL?.trim();
const NTFY_TOKEN = process.env.NTFY_TOKEN?.trim();
const NTFY_PRIORITY = process.env.NTFY_PRIORITY?.trim();

export function isNtfyConfigured(): boolean {
  return Boolean(NTFY_URL);
}

/** Redacted config summary for the health endpoint (never leaks the topic). */
export function ntfyStatus(): { configured: boolean; host: string | null } {
  if (!NTFY_URL) return { configured: false, host: null };
  try {
    return { configured: true, host: new URL(NTFY_URL).host };
  } catch {
    return { configured: true, host: "invalid-url" };
  }
}

export interface NtfyMessage {
  title: string;
  message: string;
  tags?: string[]; // ntfy emoji shortcodes, e.g. ["warning","satellite"]
  priority?: string;
  click?: string; // URL opened when the notification is tapped
}

/**
 * Make a value safe to put in an HTTP header.
 *
 * Headers are ByteStrings (Latin-1) — an emoji throws "Cannot convert argument
 * to a ByteString", which silently killed every notification whose title held
 * one. Device names come off the network, so we also drop control characters
 * (CR/LF) to prevent header injection. Emoji still reach the phone via `tags`
 * (ntfy shortcodes) and the message body, which are UTF-8 safe.
 */
export function headerSafe(value: string): string {
  return [...value]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c <= 0xff && c !== 0x7f;
    })
    .join("")
    .trim();
}

/** Low-level send. Returns true on success; never throws (logs and returns false). */
export async function sendNtfy(msg: NtfyMessage): Promise<boolean> {
  if (!NTFY_URL) return false;
  try {
    const headers: Record<string, string> = {
      Title: headerSafe(msg.title),
      Priority: headerSafe(msg.priority ?? NTFY_PRIORITY ?? "default"),
    };
    if (msg.tags?.length) headers.Tags = headerSafe(msg.tags.join(","));
    if (msg.click) headers.Click = headerSafe(msg.click);
    if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;

    const res = await fetch(NTFY_URL, {
      method: "POST",
      headers,
      body: msg.message,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[ntfy] send failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[ntfy] send error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Notification for a newly-discovered device joining the network. When a
 * fingerprint scan is supplied, the alert says what the device is actually
 * exposing — the useful part for deciding whether to care.
 */
export async function notifyNewDevice(
  dev: DeviceRow,
  scan?: PortScanResult | null
): Promise<void> {
  await sendNtfy(buildNewDeviceAlert(dev, scan));
}

/** Compose the new-device alert. Split out from sending so it can be tested. */
export function buildNewDeviceAlert(
  dev: DeviceRow,
  scan?: PortScanResult | null
): NtfyMessage {
  const name = displayNameOf(dev);
  const lines = [
    `IP: ${dev.ip ?? "?"}`,
    `MAC: ${dev.mac ?? "unknown"}`,
    `Vendor: ${dev.vendor ?? "unknown"}`,
  ];
  if (dev.os_guess) lines.push(`OS: ${dev.os_guess}`);
  if (dev.randomized) lines.push("⚠️ randomized (privacy) MAC");

  const risky = scan?.scanned ? scan.risks.length : 0;
  if (scan?.scanned) {
    lines.push("");
    lines.push(
      scan.ports.length
        ? `Open ports: ${scan.ports.map((p) => p.port).join(", ")}`
        : "No open ports found"
    );
    for (const risk of scan.risks) lines.push(`⚠️ ${risk}`);
  }

  // An alert you can't act on is just anxiety. When we have no real name, the
  // recipient is staring at "Intel Corporate · .59" with no way forward — so
  // point at the one place that CAN name it. The router sees the DHCP hostname
  // the device announced at join time; Polaris never gets to see that.
  if (!dev.label && !dev.hostname && dev.mac) {
    lines.push("");
    lines.push("Don't recognize it? Look up this MAC in your router's");
    lines.push("device list — it sees names Polaris can't.");
  }

  // "New device on your network" is a claim we cannot support: all we know is
  // that it's new to OUR records. A device can be newly-visible rather than
  // newly-arrived — a scanner improvement surfaced four devices that had been
  // sitting there for months, and every one of them said "new on your network".
  const title = risky
    ? `New device (${risky} risky port${risky > 1 ? "s" : ""}): ${name}`
    : `New device seen: ${name}`;

  return {
    title,
    message: lines.join("\n"),
    tags: risky ? ["rotating_light", "warning"] : dev.randomized ? ["warning", "detective"] : ["satellite", "eye"],
    priority: risky ? "urgent" : "high",
  };
}
