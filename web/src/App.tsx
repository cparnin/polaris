import { useEffect, useMemo, useState, useCallback } from "react";
import { api, displayName, type Device, type ScanSummary, type NetEvent, type NtfyStatus } from "./api.js";
import { StatBar } from "./components/StatBar.js";
import { NetworkMap } from "./components/NetworkMap.js";
import { DeviceCard } from "./components/DeviceCard.js";
import { EventFeed } from "./components/EventFeed.js";

type Filter = "all" | "online" | "untrusted" | "new";

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [events, setEvents] = useState<NetEvent[]>([]);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [ntfy, setNtfy] = useState<NtfyStatus | null>(null);
  const [testMsg, setTestMsg] = useState<string>("");

  const refresh = useCallback(async () => {
    const [d, e] = await Promise.all([api.devices(), api.events(80)]);
    setDevices(d.devices);
    setLastScan(d.lastScan);
    setScanning(d.scanning);
    setEvents(e.events);
  }, []);

  useEffect(() => {
    void refresh();
    void api.health().then((h) => setNtfy(h.ntfy)).catch(() => setNtfy(null));
  }, [refresh]);

  const testNotify = async () => {
    setTestMsg("sending…");
    const ok = await api.notifyTest();
    setTestMsg(ok ? "sent ✓" : "failed");
    setTimeout(() => setTestMsg(""), 3000);
  };

  // Live updates via server-sent events.
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("scan:start", () => setScanning(true));
    es.addEventListener("scan:done", (ev) => {
      setScanning(false);
      const summary = JSON.parse((ev as MessageEvent).data) as ScanSummary;
      setLastScan(summary);
      if (summary.diff.newDevices.length) {
        setNewIds((prev) => new Set([...prev, ...summary.diff.newDevices]));
      }
      void refresh();
    });
    es.addEventListener("scan:error", () => setScanning(false));
    return () => es.close();
  }, [refresh]);

  const triggerScan = async () => {
    setScanning(true);
    try {
      await api.scan();
    } catch {
      setScanning(false);
    }
  };

  const rename = async (id: string, label: string) => {
    setDevices((ds) => ds.map((d) => (d.id === id ? { ...d, label: label || null } : d)));
    await api.update(id, { label });
  };
  const trust = async (id: string, trusted: boolean) => {
    setDevices((ds) => ds.map((d) => (d.id === id ? { ...d, trusted: trusted ? 1 : 0 } : d)));
    await api.update(id, { trusted });
  };

  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices
      .filter((d) => {
        if (filter === "online" && d.online !== 1) return false;
        if (filter === "untrusted" && (d.trusted === 1 || d.online !== 1)) return false;
        if (filter === "new" && !newIds.has(d.id)) return false;
        if (!q) return true;
        return `${displayName(d)} ${d.ip} ${d.mac} ${d.vendor}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // online first, then new, then by IP
        if (a.online !== b.online) return b.online - a.online;
        const an = newIds.has(a.id) ? 1 : 0;
        const bn = newIds.has(b.id) ? 1 : 0;
        if (an !== bn) return bn - an;
        return (a.ip ?? "").localeCompare(b.ip ?? "", undefined, { numeric: true });
      });
  }, [devices, query, filter, newIds]);

  const filters: [Filter, string][] = [
    ["all", "All"],
    ["online", "Online"],
    ["untrusted", "Untrusted"],
    ["new", "New"],
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="Iris" className="h-11 w-11" />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Iris</h1>
            <p className="mt-0.5 text-sm text-zinc-500">
              {lastScan ? (
                <>
                  {lastScan.iface} · {lastScan.cidr} ·{" "}
                  <span className="text-zinc-400">{lastScan.hostCount} hosts</span> in{" "}
                  {(lastScan.durationMs / 1000).toFixed(1)}s
                </>
              ) : (
                "Discovering your network…"
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {ntfy && (
            <button
              onClick={ntfy.configured ? testNotify : undefined}
              title={ntfy.configured ? `ntfy → ${ntfy.host} (click to test)` : "ntfy not configured — set NTFY_URL"}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${
                ntfy.configured
                  ? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
                  : "cursor-default bg-white/5 text-zinc-500"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${ntfy.configured ? "bg-sky-400" : "bg-zinc-600"}`} />
              {testMsg || (ntfy.configured ? "alerts on" : "alerts off")}
            </button>
          )}
          <button
            onClick={triggerScan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {scanning ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                Scanning…
              </>
            ) : (
              <>⟳ Scan now</>
            )}
          </button>
        </div>
      </header>

      <StatBar devices={devices} />

      <NetworkMap devices={devices} onSelect={(d) => setQuery(displayName(d))} />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* Devices */}
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, IP, MAC, vendor…"
              className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
            />
            <div className="flex gap-1">
              {filters.map(([f, label]) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                    filter === f
                      ? "bg-white/10 text-white"
                      : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((d) => (
              <DeviceCard
                key={d.id}
                device={d}
                isNew={newIds.has(d.id)}
                onRename={rename}
                onTrust={trust}
              />
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="rounded-xl border border-dashed border-white/10 py-12 text-center text-sm text-zinc-500">
              {devices.length === 0
                ? "First scan running — devices will appear here shortly."
                : "No devices match this filter."}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <EventFeed events={events} byId={byId} />
      </div>

      <footer className="mt-8 text-center text-xs text-zinc-600">
        Iris · Phase 2 · Visibility + Alerts. Rename devices, mark trusted, get pinged when
        something new joins.
      </footer>
    </div>
  );
}
