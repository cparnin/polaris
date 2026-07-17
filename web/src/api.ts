export interface Device {
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
}

export interface ScanSummary {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cidr: string;
  iface: string;
  hostCount: number;
  diff: { newDevices: string[]; cameOnline: string[]; wentOffline: string[] };
}

export interface NetEvent {
  id: number;
  ts: number;
  type: "new_device" | "online" | "offline";
  device_id: string;
  detail: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface NtfyStatus {
  configured: boolean;
  host: string | null;
}

export interface OpenPort {
  port: number;
  proto: string;
  service: string | null;
  product: string | null;
  risk: string | null;
}

export interface PortScanResult {
  available: boolean;
  ip: string;
  scannedAt: number;
  durationMs: number;
  ports: OpenPort[];
  risks: string[];
  message: string | null;
}

export const api = {
  devices: () =>
    fetch("/api/devices").then(
      json<{ devices: Device[]; lastScan: ScanSummary | null; scanning: boolean }>
    ),
  events: (limit = 100) =>
    fetch(`/api/events?limit=${limit}`).then(json<{ events: NetEvent[] }>),
  health: () =>
    fetch("/api/health").then(json<{ ok: boolean; ntfy: NtfyStatus }>),
  notifyTest: () =>
    fetch("/api/notify/test", { method: "POST" }).then((r) => r.ok),
  scan: () => fetch("/api/scan", { method: "POST" }).then(json<{ ok: boolean }>),
  update: (id: string, patch: { label?: string; trusted?: boolean }) =>
    fetch(`/api/devices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<{ ok: boolean }>),
  portScan: (id: string) =>
    fetch(`/api/devices/${encodeURIComponent(id)}/portscan`, { method: "POST" }).then(
      json<PortScanResult>
    ),
};

/** Friendly display name for a device: label > hostname > vendor + last octet. */
export function displayName(d: Device): string {
  if (d.label) return d.label;
  if (d.hostname) return d.hostname;
  const tail = d.ip?.split(".").pop() ?? "?";
  if (d.vendor && !d.vendor.startsWith("Private")) return `${d.vendor} · .${tail}`;
  return `Unknown · .${tail}`;
}
