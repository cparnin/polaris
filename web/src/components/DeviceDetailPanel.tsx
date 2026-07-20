import { useMemo, useState } from "react";
import type { Device, OpenPort, PortScanResult } from "../api.js";
import { api, displayName } from "../api.js";
import { deviceIcon, relTime } from "../deviceMeta.js";

/**
 * Slide-in inspector for a single device: identity plus an on-demand nmap
 * service scan (open ports, detected services, and risky-exposure flags). This
 * is what turns the map into a security tool — click a node, see what it's
 * actually exposing on the LAN.
 */
export function DeviceDetailPanel({
  device: d,
  onClose,
  onScanned,
}: {
  device: Device;
  onClose: () => void;
  onScanned: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<PortScanResult | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  const forget = async () => {
    await api.forget(d.id).catch(() => {});
    onScanned(); // refresh the device list
    onClose();
  };

  // Fall back to the device's last persisted scan until a fresh one runs.
  const persistedPorts = useMemo<OpenPort[]>(() => {
    if (!d.open_ports) return [];
    try {
      return JSON.parse(d.open_ports) as OpenPort[];
    } catch {
      return [];
    }
  }, [d.open_ports]);

  const ports = result?.ports ?? persistedPorts;
  const risks = result?.risks ?? [...new Set(persistedPorts.map((p) => p.risk).filter(Boolean))];
  const hasScan = result != null || d.last_portscan_at != null;
  const message = result?.message ?? null;

  const runScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      setResult(await api.portScan(d.id));
      onScanned(); // refresh the device list so map badges update
    } catch (err) {
      setResult({
        available: true,
        scanned: false,
        ip: d.ip ?? "",
        scannedAt: Date.now(),
        durationMs: 0,
        ports: [],
        risks: [],
        message: `Scan error: ${(err as Error).message}`,
      });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label={`Details for ${displayName(d)}`}>
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <aside className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-white/10 bg-[#0b0d12] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{deviceIcon(d)}</span>
            <div>
              <h2 className="text-base font-semibold text-white">{displayName(d)}</h2>
              <p className="text-xs text-zinc-500">
                {d.ip}
                {d.mac ? ` · ${d.mac}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/5 hover:text-white"
          >
            ✕
          </button>
        </header>

        {/* identity facts */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 text-sm">
          <Fact label="Status" value={d.online ? "Online" : "Offline"} accent={d.online ? "text-emerald-400" : "text-zinc-500"} />
          <Fact label="Trust" value={d.trusted ? "Trusted" : "Untrusted"} accent={d.trusted ? "text-emerald-400" : "text-amber-400"} />
          <Fact label="Vendor" value={d.vendor ?? "—"} />
          <Fact label="OS hint" value={d.os_guess ?? "—"} />
          {d.randomized === 1 && <Fact label="MAC" value="Randomized (privacy)" accent="text-sky-400" />}
        </dl>

        {/* port scan */}
        <section className="border-t border-white/10 px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Open ports &amp; services</h3>
            <button
              onClick={runScan}
              disabled={scanning}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {scanning ? "scanning…" : hasScan ? "↻ rescan" : "⌖ scan ports"}
            </button>
          </div>

          {scanning && (
            <p className="text-xs text-zinc-500">Running nmap service scan — this can take 10–40s…</p>
          )}

          {!scanning && !hasScan && (
            <p className="text-xs text-zinc-500">
              Not scanned yet. A service scan (nmap) reveals which ports this device exposes
              and flags risky ones (SMB, RDP, Telnet, VNC).
            </p>
          )}

          {!scanning && message && ports.length === 0 && (
            <p className="text-xs text-zinc-400">{message}</p>
          )}

          {risks.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span className="font-semibold">⚠ {risks.length} risky exposure{risks.length > 1 ? "s" : ""}:</span>{" "}
              {risks.join(", ")}
            </div>
          )}

          {ports.length > 0 && (
            <ul className="divide-y divide-white/5">
              {ports.map((p) => (
                <li key={`${p.proto}-${p.port}`} className="flex items-center justify-between py-2 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono tabular-nums text-white">{p.port}</span>
                    <span className="text-xs text-zinc-500">{p.proto}</span>
                    <span className="text-zinc-300">{p.service ?? "unknown"}</span>
                    {p.product && <span className="text-xs text-zinc-500">{p.product}</span>}
                  </div>
                  {p.risk && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
                      ▲ {p.risk}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {hasScan && d.last_portscan_at != null && !result && (
            <p className="mt-2 text-[11px] text-zinc-600">last scanned {relTime(d.last_portscan_at)}</p>
          )}
          {result?.scanned && (
            <p className="mt-2 text-[11px] text-zinc-600">
              {ports.length} open · scanned in {(result.durationMs / 1000).toFixed(0)}s
            </p>
          )}
        </section>

        {/* forget — for clearing dead records (e.g. devices from an old subnet) */}
        <section className="mt-auto border-t border-white/10 px-5 py-4">
          <button
            onClick={confirmForget ? forget : () => setConfirmForget(true)}
            onMouseLeave={() => setConfirmForget(false)}
            className={`w-full rounded-lg px-3 py-2 text-xs transition-colors ${
              confirmForget
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-white/5 text-zinc-400 hover:bg-red-500/20 hover:text-red-300"
            }`}
          >
            {confirmForget ? "Confirm — forget this device?" : "Forget this device"}
          </button>
          <p className="mt-2 text-[11px] text-zinc-600">
            Removes it and its history. If it's still on your network it reappears on the
            next scan.
          </p>
        </section>
      </aside>
    </div>
  );
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-600">{label}</dt>
      <dd className={`mt-0.5 ${accent ?? "text-zinc-200"}`}>{value}</dd>
    </div>
  );
}
