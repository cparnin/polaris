import { useEffect, useMemo, useState, useCallback } from "react";
import { api, displayName, type Device, type ScanSummary, type NetEvent, type NtfyStatus } from "./api.js";
import { StatBar } from "./components/StatBar.js";
import { NetworkMap } from "./components/NetworkMap.js";
import { DeviceDetailPanel } from "./components/DeviceDetailPanel.js";
import { DeviceCard } from "./components/DeviceCard.js";
import { EventFeed } from "./components/EventFeed.js";
import { NameDevices } from "./components/NameDevices.js";

type Filter = "all" | "online" | "untrusted" | "new";

/** How long a device stays flagged NEW before the badge expires on its own. */
const NEW_BADGE_MS = 6 * 60 * 60 * 1000; // 6 hours

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [events, setEvents] = useState<NetEvent[]>([]);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  // When each device was first flagged new, so the badge can expire on its own.
  const [newSince, setNewSince] = useState<Map<string, number>>(new Map());
  const [ntfy, setNtfy] = useState<NtfyStatus | null>(null);
  const [ispName, setIspName] = useState("Internet / ISP");
  const [testMsg, setTestMsg] = useState<string>("");
  const [paused, setPaused] = useState(false);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  // The whole point of this dashboard is "what is on my network RIGHT NOW".
  // Showing a stale device list as if it were live is worse than showing
  // nothing, so a lost connection has to be visible.
  const [connected, setConnected] = useState(true);
  // Distinguishes "no devices" from "we haven't asked yet".
  const [loaded, setLoaded] = useState(false);
  const [naming, setNaming] = useState(false);
  // ms of guest mode left; 0 = off. Guests' phones use randomized MACs, so each
  // visit looks like a brand-new device and fires another push.
  const [guestMs, setGuestMs] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [d, e] = await Promise.all([api.devices(), api.events(80)]);
      setDevices(d.devices);
      setLastScan(d.lastScan);
      setScanning(d.scanning);
      setPaused(d.paused);
      setEvents(e.events);
      setConnected(true);
      setLoaded(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api
      .health()
      .then((h) => {
        setNtfy(h.ntfy);
        if (h.ispName) setIspName(h.ispName);
        setGuestMs(h.guestModeMsLeft ?? 0);
      })
      .catch(() => setNtfy(null));
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
        setNewSince((prev) => {
          const next = new Map(prev);
          for (const id of summary.diff.newDevices) next.set(id, Date.now());
          return next;
        });
      }
      void refresh();
    });
    es.addEventListener("scan:error", () => setScanning(false));
    es.addEventListener("scan:paused", (ev) => {
      setPaused((JSON.parse((ev as MessageEvent).data) as { paused: boolean }).paused);
    });
    // EventSource reconnects on its own; onerror fires on each failed attempt.
    // CONNECTING after an error means "retrying", which is still disconnected
    // as far as the user is concerned.
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(es.readyState === EventSource.OPEN);
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

  const togglePause = async () => {
    const next = !paused;
    setPaused(next); // optimistic
    try {
      await (next ? api.pause() : api.resume());
    } catch {
      setPaused(!next); // revert on failure
    }
  };

  // Tick the guest-mode countdown down locally so the label stays honest.
  useEffect(() => {
    if (guestMs <= 0) return;
    const t = setInterval(() => setGuestMs((ms) => Math.max(0, ms - 60_000)), 60_000);
    return () => clearInterval(t);
  }, [guestMs]);

  const toggleGuest = async () => {
    const hours = guestMs > 0 ? 0 : 4;
    const prev = guestMs;
    setGuestMs(hours * 3_600_000); // optimistic
    try {
      const r = await api.guestMode(hours);
      setGuestMs(r.msLeft);
    } catch {
      setGuestMs(prev);
    }
  };

  const quit = async () => {
    await api.quit().catch(() => {});
    setStopped(true);
  };

  // Never leave "Confirm quit?" armed. On touch there's no mouseleave, so one
  // stray tap later would kill the service.
  useEffect(() => {
    if (!confirmQuit) return;
    const t = setTimeout(() => setConfirmQuit(false), 4000);
    return () => clearTimeout(t);
  }, [confirmQuit]);

  // Expire the NEW badge. It only ever accumulated, so a device stayed ringed
  // and populated the "New" filter until you happened to reload the page -
  // which made the badge mean "new at some point" rather than "new".
  useEffect(() => {
    if (newSince.size === 0) return;
    const tick = () => {
      const cutoff = Date.now() - NEW_BADGE_MS;
      const survivors = [...newSince].filter(([, at]) => at > cutoff);
      if (survivors.length === newSince.size) return; // nothing expired yet
      setNewSince(new Map(survivors));
      setNewIds(new Set(survivors.map(([id]) => id)));
    };
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [newSince]);

  // Optimistic, but reconciled: on failure re-read the server's truth rather
  // than leaving the UI asserting a change that didn't persist.
  const rename = useCallback(
    async (id: string, label: string) => {
      setDevices((ds) => ds.map((d) => (d.id === id ? { ...d, label: label || null } : d)));
      try {
        await api.update(id, { label });
      } catch {
        void refresh();
      }
    },
    [refresh],
  );
  const trust = useCallback(
    async (id: string, trusted: boolean) => {
      setDevices((ds) => ds.map((d) => (d.id === id ? { ...d, trusted: trusted ? 1 : 0 } : d)));
      try {
        await api.update(id, { trusted });
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const unnamedCount = useMemo(() => devices.filter((d) => !d.label).length, [devices]);

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

  if (stopped) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <img src="/logo.svg" alt="Polaris" className="h-14 w-14 opacity-60" />
        <h1 className="text-2xl font-bold text-white">Polaris is stopped</h1>
        <p className="max-w-md text-sm text-zinc-400">
          The scanner and dashboard have shut down and won't restart on their own until
          your next login. To bring Polaris back now, run this in your terminal:
        </p>
        <code className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-emerald-300">
          ./polaris start
        </code>
        <p className="text-xs text-zinc-500">Then reload this page.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {naming && (
        <NameDevices devices={devices} onRename={rename} onClose={() => setNaming(false)} />
      )}

      {/* Everything below this banner is last-known state, not live state. Say
          so loudly - a confident stale network map is this tool's worst lie. */}
      {!connected && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          <span aria-hidden="true">⚠</span>
          <span>
            <span className="font-semibold">Disconnected from Polaris.</span> Showing the last known
            state - it may be out of date. Retrying automatically; if it doesn't come back, run{" "}
            <code className="rounded bg-black/30 px-1 py-0.5 text-amber-100">./polaris status</code>.
          </span>
        </div>
      )}

      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="Polaris" className="h-11 w-11" />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Polaris</h1>
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
              {paused && <span className="font-medium text-amber-400"> · paused</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {ntfy && (
            <button
              onClick={ntfy.configured ? testNotify : undefined}
              title={ntfy.configured ? `ntfy → ${ntfy.host} (click to test)` : "ntfy not configured - set NTFY_URL"}
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
            onClick={toggleGuest}
            title={
              guestMs > 0
                ? "New-device alerts are muted. Devices are still recorded."
                : "Having people over? Mute new-device alerts for 4 hours."
            }
            className={`rounded-lg px-3 py-2 text-xs transition-colors ${
              guestMs > 0
                ? "bg-violet-500/20 text-violet-200 hover:bg-violet-500/30"
                : "bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            {guestMs > 0 ? `👥 Guests ${Math.ceil(guestMs / 3_600_000)}h` : "👥 Guest mode"}
          </button>
          <button
            onClick={() => setNaming(true)}
            title="Name your devices in one list"
            className="rounded-lg bg-white/5 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            ✎ Name devices{unnamedCount > 0 ? ` (${unnamedCount})` : ""}
          </button>
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
          <button
            onClick={togglePause}
            title={paused ? "Auto-scanning is paused - click to resume" : "Pause auto-scanning"}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              paused
                ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                : "bg-white/5 text-zinc-300 hover:bg-white/10"
            }`}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button
            onClick={confirmQuit ? quit : () => setConfirmQuit(true)}
            onBlur={() => setConfirmQuit(false)}
            onMouseLeave={() => setConfirmQuit(false)}
            title="Stop Polaris entirely (server + dashboard)"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              confirmQuit
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-white/5 text-zinc-400 hover:bg-red-500/20 hover:text-red-300"
            }`}
          >
            {confirmQuit ? "Confirm quit?" : "⏻ Quit"}
          </button>
        </div>
      </header>

      <StatBar devices={devices} loading={!loaded} />

      <NetworkMap devices={devices} onInspect={(d) => setInspectId(d.id)} ispName={ispName} />

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
                ? "First scan running - devices will appear here shortly."
                : "No devices match this filter."}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <EventFeed events={events} byId={byId} />
      </div>

      <footer className="mt-8 text-center text-xs text-zinc-500">
        Polaris · Phase 2 · Visibility + Alerts. Rename devices, mark trusted, get pinged when
        something new joins.
      </footer>

      {inspectId && byId.get(inspectId) && (
        <DeviceDetailPanel
          device={byId.get(inspectId)!}
          onClose={() => setInspectId(null)}
          onScanned={refresh}
        />
      )}
    </div>
  );
}
