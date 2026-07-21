import { useEffect, useMemo, useRef, useState } from "react";
import { displayName, type Device } from "../api.js";
import { deviceIcon } from "../deviceMeta.js";

/**
 * Bulk naming screen.
 *
 * Naming devices one at a time meant hunting each card down in the grid, and
 * the useful names live in the router's app — so you're cross-referencing two
 * screens. This puts every device in one list, unnamed first, with the vendor
 * and MAC visible (the two things you match against) and a field you can tab
 * straight through.
 */
export function NameDevices({
  devices,
  onRename,
  onClose,
}: {
  devices: Device[];
  onRename: (id: string, label: string) => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => firstInput.current?.focus(), []);

  // Unnamed first — that's the work to be done — then by IP within each group.
  const rows = useMemo(() => {
    const byIp = (a: Device, b: Device) =>
      (a.ip ?? "").localeCompare(b.ip ?? "", undefined, { numeric: true });
    const named = (d: Device) => Boolean(d.label);
    return [...devices].sort((a, b) => {
      if (named(a) !== named(b)) return named(a) ? 1 : -1;
      return byIp(a, b);
    });
  }, [devices]);

  const commit = (d: Device) => {
    const next = (drafts[d.id] ?? d.label ?? "").trim();
    if (next === (d.label ?? "")) return;
    onRename(d.id, next);
    setSaved((s) => ({ ...s, [d.id]: true }));
    setTimeout(() => setSaved((s) => ({ ...s, [d.id]: false })), 1500);
  };

  const remaining = rows.filter((d) => !d.label).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Name devices"
    >
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0b0d12] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Name your devices</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              {remaining > 0
                ? `${remaining} still unnamed. Match them by vendor and MAC against your router's device list.`
                : "Everything has a name. Nice."}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/5 hover:text-white"
          >
            ✕
          </button>
        </header>

        <ul className="divide-y divide-white/5">
          {rows.map((d, i) => (
            <li key={d.id} className="flex items-center gap-3 px-5 py-2.5">
              <span className="w-6 shrink-0 text-center text-lg">{deviceIcon(d)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs tabular-nums text-zinc-300">{d.ip}</span>
                  <span className="truncate text-xs text-zinc-400">{d.vendor ?? "unknown vendor"}</span>
                  {d.online !== 1 && <span className="text-[10px] text-zinc-500">offline</span>}
                </div>
                <div className="select-all font-mono text-[10px] text-zinc-500">{d.mac ?? "no mac"}</div>
              </div>
              <div className="relative w-56 shrink-0">
                <input
                  ref={i === 0 ? firstInput : undefined}
                  value={drafts[d.id] ?? d.label ?? ""}
                  onChange={(e) => setDrafts((s) => ({ ...s, [d.id]: e.target.value }))}
                  onBlur={() => commit(d)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      e.stopPropagation(); // don't close the whole dialog mid-edit
                      setDrafts((s) => ({ ...s, [d.id]: d.label ?? "" }));
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={displayName(d)}
                  aria-label={`Name for ${d.ip}`}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white placeholder:text-zinc-600 focus:border-emerald-500/60"
                />
                {saved[d.id] && (
                  <span className="absolute -right-5 top-2 text-xs text-emerald-400" aria-hidden="true">
                    ✓
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>

        <footer className="border-t border-white/10 px-5 py-3 text-[11px] text-zinc-500">
          Saves as you go — Tab to the next device, Esc to close.
        </footer>
      </div>
    </div>
  );
}
