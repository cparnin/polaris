import { useMemo, useState } from "react";
import type { Device } from "../api.js";
import { displayName } from "../api.js";
import { deviceIcon, relTime, scanStatus } from "../deviceMeta.js";

/** Trust status → ring color + legend label. Also encoded by tier/group/icon,
 *  so the view never relies on color alone. */
const STATUS = {
  gateway: { ring: "#38bdf8", label: "Gateway" },
  self: { ring: "#a78bfa", label: "This Mac" },
  trusted: { ring: "#34d399", label: "Trusted" },
  untrusted: { ring: "#fbbf24", label: "Untrusted" },
} as const;

type Status = keyof typeof STATUS;

function statusOf(d: Device): Status {
  if (d.is_gateway) return "gateway";
  if (d.is_self) return "self";
  return d.trusted === 1 ? "trusted" : "untrusted";
}

/** Which cluster a device belongs to. Your own Mac counts as trusted. */
function groupKeyOf(d: Device): "trusted" | "untrusted" {
  return d.is_self || d.trusted === 1 ? "trusted" : "untrusted";
}

/**
 * Grouping by what a device IS, as an alternative to whether you trust it.
 * Trust answers "should I worry"; kind answers "what am I looking at" - useful
 * once a network has 20+ devices and the untrusted zone is just a wall of bulbs.
 */
const KIND_DEFS = [
  { key: "compute", label: "Computers & phones", color: "#a78bfa" },
  { key: "media", label: "Speakers & displays", color: "#38bdf8" },
  { key: "iot", label: "Smart home", color: "#fbbf24" },
  { key: "other", label: "Other", color: "#94a3b8" },
] as const;

/** Bucket a device by vendor and OS hint - coarse on purpose. */
function kindKeyOf(d: Device): string {
  const v = (d.vendor ?? "").toLowerCase();
  const name = `${d.label ?? ""} ${d.hostname ?? ""}`.toLowerCase();
  if (d.randomized === 1 || /intel|apple|winstars|dell|samsung|microsoft/.test(v)) return "compute";
  if (/android|iphone|pixel|laptop|macbook|desktop|pc\b/.test(name)) return "compute";
  if (/speaker|display|\btv\b|cast|sonos|roku/.test(name)) return "media";
  if (/sony|wnc|roku|vizio|lg electronics/.test(v)) return "media";
  if (/google/.test(v) && /speaker|display|tv|home|mini|nest/.test(name)) return "media";
  if (/tp-link|espressif|tuya|shelly|sonoff|resideo|honeywell|amazon|chamberlain|alpha networks/.test(v))
    return "iot";
  if (/bulb|light|switch|plug|thermostat|garage|door|cam|sensor|alarm/.test(name)) return "iot";
  if (/google/.test(v)) return "media";
  return "other";
}

/**
 * The whole dashboard body: a map-shaped card layout. Internet → gateway →
 * firewall boundary → zones of compact device tiles, all plain DOM that
 * scrolls with the page. Deliberately NOT a pan/zoom canvas: the zoomable SVG
 * hijacked the wheel anywhere over it and needed camera code to stay smooth.
 * Clicking a tile opens the detail panel (identity, rename, trust, port scan).
 */
export function TopologyView({
  devices,
  visible,
  newIds,
  queryActive,
  onInspect,
  ispName = "Internet / ISP",
}: {
  /** Every known device; the gateway anchors the layout even when filtered. */
  devices: Device[];
  /** Devices that pass the current search + filter, in display order. */
  visible: Device[];
  newIds: Set<string>;
  /** A live search reveals offline matches even with "show offline" off. */
  queryActive: boolean;
  onInspect: (d: Device) => void;
  ispName?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showOffline, setShowOffline] = useState(false);
  const [groupBy, setGroupBy] = useState<"trust" | "kind">("trust");

  const hub = devices.find((d) => d.is_gateway) ?? null;
  const onlineCount = devices.filter((d) => d.online === 1).length;

  const groups = useMemo(() => {
    const tiles = visible.filter(
      (d) => d.id !== hub?.id && (d.online === 1 || showOffline || queryActive)
    );
    const defs =
      groupBy === "kind"
        ? KIND_DEFS
        : [
            { key: "trusted", label: "Trusted", color: STATUS.trusted.ring },
            { key: "untrusted", label: "Untrusted", color: STATUS.untrusted.ring },
          ];
    return defs
      .map((def) => ({
        ...def,
        devices: tiles.filter((d) =>
          groupBy === "kind" ? kindKeyOf(d) === def.key : groupKeyOf(d) === def.key
        ),
      }))
      .filter((g) => g.devices.length > 0);
  }, [visible, hub, showOffline, queryActive, groupBy]);

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02]">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">Network</h2>
          <span className="text-xs text-zinc-500">{onlineCount} online</span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {Object.entries(STATUS).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: v.ring }} />
                {v.label}
              </span>
            ))}
          </div>
          <button
            onClick={() => setGroupBy((g) => (g === "trust" ? "kind" : "trust"))}
            title="Group devices by trust, or by what they are"
            className="rounded-lg px-2 py-1 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          >
            {groupBy === "trust" ? "by trust" : "by type"}
          </button>
          <button
            onClick={() => setShowOffline((v) => !v)}
            title="Show devices that are known but not currently online"
            className="rounded-lg px-2 py-1 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          >
            {showOffline ? "hide offline" : "show offline"}
          </button>
        </div>
      </header>

      {devices.length === 0 ? (
        <div className="px-4 pb-6 pt-2 text-center text-sm text-zinc-500">
          First scan running - devices will appear here shortly.
        </div>
      ) : (
        <div className="px-4 pb-5">
          {/* Internet → gateway spine. Drawn from local facts only: naming a
              public IP here would mean calling a third-party service, which
              would break the "no outbound requests" promise. */}
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-400">
              <span aria-hidden="true">🌐</span> {ispName}
            </div>
            <div className="h-5 w-px bg-white/15" aria-hidden="true" />
            {hub && <DeviceTile d={hub} isNew={false} onInspect={onInspect} big />}
          </div>

          {/* The gateway is the firewall/NAT boundary: everything above this
              line is outside your control, everything below trusts everything
              else. */}
          <div className="relative my-5" aria-hidden="true">
            <div className="border-t border-dashed border-sky-400/25" />
            <span className="absolute -top-2.5 left-2 bg-[#0f1117] px-2 text-[10px] text-sky-400/75">
              🛡 firewall / NAT - your LAN below
            </span>
          </div>

          {/* Zones */}
          {groups.length === 0 ? (
            <div className="py-6 text-center text-sm text-zinc-500">
              No devices match. Offline devices are hidden - try "show offline" or clear the filter.
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-center gap-4">
              {groups.map((g) => {
                const isCollapsed = collapsed[g.key] ?? false;
                return (
                  <div
                    key={g.key}
                    className="min-w-[280px] max-w-full flex-1 rounded-xl border p-3"
                    style={{ borderColor: `${g.color}59`, backgroundColor: `${g.color}0a` }}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold" style={{ color: g.color }}>
                        {g.label}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-zinc-400">{g.devices.length}</span>
                        <button
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${g.label}`}
                          onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !isCollapsed }))}
                          className="flex h-5 w-5 items-center justify-center rounded bg-white/5 text-sm text-zinc-300 hover:bg-white/10"
                        >
                          {isCollapsed ? "+" : "–"}
                        </button>
                      </span>
                    </div>
                    {!isCollapsed && (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                        {g.devices.map((d) => (
                          <DeviceTile key={d.id} d={d} isNew={newIds.has(d.id)} onInspect={onInspect} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One device as a compact tile: status ring color, icon, name, IP, and the
 * exposure badge (red count = risky ports, green ✓ = scanned clean, grey ✓ =
 * was clean but the scan is old enough to distrust). Click to inspect.
 */
function DeviceTile({
  d,
  isNew,
  onInspect,
  big = false,
}: {
  d: Device;
  isNew: boolean;
  onInspect: (d: Device) => void;
  big?: boolean;
}) {
  const color = STATUS[statusOf(d)].ring;
  const name = displayName(d);
  const scan = scanStatus(d);
  const online = d.online === 1;
  const title =
    `${name}${d.ip ? ` · ${d.ip}` : ""}` +
    (scan.status === "risky"
      ? ` · ${scan.riskCount} risky port${scan.riskCount > 1 ? "s" : ""}`
      : scan.status === "clean"
        ? " · no risky ports"
        : scan.status === "stale"
          ? ` · clean when scanned ${relTime(d.last_portscan_at!)} - stale, rescan to confirm`
          : "");
  return (
    <button
      onClick={() => onInspect(d)}
      title={title}
      aria-label={`${name}${d.ip ? `, ${d.ip}` : ""}${online ? "" : ", offline"}${
        scan.status === "risky" ? `, ${scan.riskCount} risky ports` : ""
      } - open details`}
      className={`relative flex items-center gap-2.5 rounded-lg border text-left transition-colors hover:bg-white/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400 ${
        big ? "px-4 py-2.5" : "px-2.5 py-2"
      } ${online ? "bg-white/[0.03]" : "border-dashed opacity-50 hover:opacity-90"} ${
        isNew ? "ring-2 ring-amber-400/60" : ""
      }`}
      style={{ borderColor: `${color}66` }}
    >
      {isNew && (
        <span className="absolute -top-2 left-2 rounded-full bg-amber-400 px-1.5 text-[9px] font-bold text-black">
          NEW
        </span>
      )}
      <span className={big ? "text-2xl" : "text-xl"} aria-hidden="true">
        {deviceIcon(d)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-medium text-zinc-100 ${big ? "text-sm" : "text-xs"}`}>
          {name}
        </span>
        <span className="block truncate font-mono text-[10px] text-zinc-500">
          {d.ip ?? "no ip"}
          {!online && ` · seen ${relTime(d.last_seen)}`}
        </span>
      </span>
      {scan.status !== "unscanned" && (
        <span
          className={`absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[#0b0d12] px-1 text-[10px] font-bold ${
            scan.status === "risky"
              ? "bg-red-500 text-black"
              : scan.status === "stale"
                ? "bg-zinc-700 text-zinc-400"
                : "bg-emerald-500 text-black"
          }`}
        >
          {scan.status === "risky" ? scan.riskCount : "✓"}
        </span>
      )}
    </button>
  );
}
