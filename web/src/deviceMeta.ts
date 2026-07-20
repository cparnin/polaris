import type { Device } from "./api.js";

/** Infer a rough device category + emoji icon from vendor/hostname signals. */
export function deviceIcon(d: Device): string {
  const hay = `${d.vendor ?? ""} ${d.hostname ?? ""}`.toLowerCase();
  if (d.is_gateway) return "🛜";
  const rules: [RegExp, string][] = [
    [/eero|ubiquiti|netgear|tp-link|asus|linksys|router|access point|aruba/, "📡"],
    [/apple|iphone|ipad|macbook|imac/, "🍎"],
    [/google|nest|pixel/, "🔵"],
    [/amazon|echo|kindle|ring|fire/, "📦"],
    [/samsung|galaxy/, "📱"],
    [/sonos|bose|speaker|audio/, "🔊"],
    [/roku|chromecast|shield|appletv|apple tv|firetv|tv|lg electronics|vizio/, "📺"],
    [/canon|epson|brother|hp inc|printer/, "🖨️"],
    [/wyze|hikvision|dahua|reolink|camera|arlo/, "📷"],
    [/hue|lifx|tuya|espressif|shelly|sonoff|smart|resideo|honeywell|ecobee/, "💡"],
    [/raspberry|intel|synology|qnap|nas|dell|lenovo|asustek/, "💻"],
    [/sony|playstation|xbox|microsoft|nintendo/, "🎮"],
  ];
  for (const [re, icon] of rules) if (re.test(hay)) return icon;
  if (d.randomized) return "🕶️";
  return "❔";
}

export type ScanStatus = "unscanned" | "clean" | "risky";

/** Port-scan exposure status for a device, derived from its persisted scan. */
export function scanStatus(d: Device): { status: ScanStatus; riskCount: number } {
  if (d.last_portscan_at == null) return { status: "unscanned", riskCount: 0 };
  const riskCount = d.risk_count ?? 0;
  return { status: riskCount > 0 ? "risky" : "clean", riskCount };
}

export function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
