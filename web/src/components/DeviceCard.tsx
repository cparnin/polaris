import { useEffect, useState } from "react";
import type { Device, PortScanResult } from "../api.js";
import { api, displayName } from "../api.js";
import { deviceIcon, relTime } from "../deviceMeta.js";

interface Props {
  device: Device;
  isNew: boolean;
  onRename: (id: string, label: string) => void;
  onTrust: (id: string, trusted: boolean) => void;
}

export function DeviceCard({ device: d, isNew, onRename, onTrust }: Props) {
  const [editing, setEditing] = useState(false);
  // Seeded once by useState, so a label changed server-side (or in another tab)
  // left this holding the old text - and blurring wrote it back, silently
  // reverting the rename. Re-seed whenever we're not actively editing.
  const [draft, setDraft] = useState(d.label ?? "");
  useEffect(() => {
    if (!editing) setDraft(d.label ?? "");
  }, [d.label, editing]);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<PortScanResult | null>(null);
  const online = d.online === 1;

  async function runPortScan() {
    if (scanning) return;
    setScanning(true);
    setScan(null);
    try {
      setScan(await api.portScan(d.id));
    } catch (err) {
      setScan({
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
  }

  return (
    <div
      className={`group relative rounded-xl border p-4 transition-colors ${
        online
          ? "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
          : "border-white/5 bg-white/[0.01] opacity-60 hover:opacity-90"
      } ${isNew ? "ring-2 ring-amber-400/60" : ""}`}
    >
      {isNew && (
        <span className="absolute -top-2 left-3 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-black">
          NEW
        </span>
      )}
      <div className="flex items-start gap-3">
        <div className="text-2xl leading-none">{deviceIcon(d)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                online ? "bg-emerald-400 online-dot" : "bg-zinc-600"
              }`}
            />
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  setEditing(false);
                  if (draft !== (d.label ?? "")) onRename(d.id, draft);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setDraft(d.label ?? "");
                    setEditing(false);
                  }
                }}
                placeholder="name this device"
                className="w-full rounded bg-black/40 px-1 text-sm text-white outline-none ring-1 ring-white/20"
              />
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="truncate text-left text-sm font-semibold text-white hover:underline"
                title="Click to rename"
              >
                {displayName(d)}
              </button>
            )}
          </div>
          <div className="mt-1 font-mono text-xs text-zinc-400">{d.ip}</div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {d.vendor ?? "unknown vendor"}
            {d.is_gateway ? " · gateway" : ""}
            {d.is_self ? " · this machine" : ""}
          </div>
          {d.os_guess && (
            <div className="mt-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {d.os_guess}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
            <span>{d.mac ?? "no mac"}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            {online ? "online now" : `last seen ${relTime(d.last_seen)}`}
          </div>
        </div>
        <button
          onClick={() => onTrust(d.id, d.trusted === 0)}
          aria-label={d.trusted ? `Untrust ${displayName(d)}` : `Mark ${displayName(d)} as trusted`}
          title={d.trusted ? "Trusted device" : "Mark as trusted"}
          // Reveal on focus and on touch too, not just hover: opacity-0 alone
          // leaves a focusable-but-invisible control for keyboard users, and
          // makes "trust" unreachable entirely on a phone.
          className={`shrink-0 rounded-md px-2 py-1 text-xs transition-colors ${
            d.trusted
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-white/5 text-zinc-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-white/10 max-sm:opacity-100"
          }`}
        >
          {d.trusted ? "✓ trusted" : "trust"}
        </button>
      </div>

      {/* Opt-in port / service scan */}
      <div className="mt-3 border-t border-white/5 pt-2">
        <button
          onClick={runPortScan}
          disabled={scanning || !d.ip}
          className="text-[11px] text-zinc-500 hover:text-sky-300 disabled:opacity-50"
          title="Run an on-demand nmap service scan of this device"
        >
          {scanning ? "scanning ports…" : scan ? "↻ rescan ports" : "⌖ scan ports"}
        </button>

        {scan && (
          <div className="mt-2 space-y-1">
            {scan.message && <div className="text-[11px] text-zinc-500">{scan.message}</div>}

            {scan.risks.length > 0 && (
              <div className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                {scan.risks.map((r) => (
                  <div key={r}>⚠ {r}</div>
                ))}
              </div>
            )}

            {scan.ports.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {scan.ports.map((p) => (
                  <span
                    key={`${p.port}/${p.proto}`}
                    title={
                      p.guessed
                        ? `Unconfirmed - "${p.service}" is only the name registered for port ${p.port}`
                        : (p.product ?? p.service ?? "")
                    }
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      p.risk
                        ? "bg-red-500/15 text-red-300"
                        : "bg-white/5 text-zinc-300"
                    }`}
                  >
                    {p.port} {p.service ?? p.proto}
                    {p.guessed && <span className="text-zinc-500">?</span>}
                  </span>
                ))}
              </div>
            )}

            {!scan.message && (
              <div className="text-[10px] text-zinc-500">
                {scan.ports.length} open · {(scan.durationMs / 1000).toFixed(0)}s
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
