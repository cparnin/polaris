import { useMemo, useRef, useState } from "react";
import type { Device } from "../api.js";
import { displayName } from "../api.js";
import { deviceIcon, scanStatus } from "../deviceMeta.js";

/** Trust status → ring color + legend label. Also encoded by tier/group/icon,
 *  so the map never relies on color alone. */
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

/** Floor for the canvas width; it grows with the total width of the zones. */
const W_MIN = 900;
/** Floor for the canvas height; the real height grows with the tallest zone. */
const H_MIN = 640;


const INTERNET_Y = 48;
const GATEWAY_Y = 158;
const GROUPS_TOP = 250;
/** Where the "inside your network" line sits, between gateway and the zones. */
const BOUNDARY_Y = 212;

// Device cell + group box geometry.
const CELL_W = 92;
const CELL_H = 86;
const MAX_COLS = 4;
const HEADER_H = 38;
const BOX_PAD = 12;
const GROUP_GAP = 40;

/**
 * Grouping by what a device IS, as an alternative to whether you trust it.
 * Trust answers "should I worry"; kind answers "what am I looking at" - useful
 * once a network has 20+ devices and the untrusted box is just a wall of bulbs.
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

interface GroupLayout {
  key: string;
  label: string;
  color: string;
  devices: Device[];
  collapsed: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
}

function truncate(s: string, n = 13): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Tiered network topology: Internet / ISP → your gateway → the LAN, with
 * devices clustered into Trusted / Untrusted zones. Scroll to zoom, drag to
 * pan, collapse a zone, and click a device to inspect it (identity + port
 * scan). Nodes carry an exposure badge once scanned, so the whole map reads as
 * a live security view.
 */
export function NetworkMap({
  devices,
  onInspect,
  ispName = "Internet / ISP",
}: {
  devices: Device[];
  onInspect?: (d: Device) => void;
  ispName?: string;
}) {
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  // Offline devices were hidden outright, so an unplugged camera simply wasn't
  // on the map and there was no way to tell that from "never existed".
  const [showOffline, setShowOffline] = useState(false);
  const [groupBy, setGroupBy] = useState<"trust" | "kind">("trust");

  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const moved = useRef(false);

  const { hub, groups, onlineCount, height: H, width: W } = useMemo(() => {
    const online = devices.filter((d) => d.online === 1);
    const shown = showOffline ? devices : online;
    const hub = shown.find((d) => d.is_gateway) ?? null;
    const spokes = shown.filter((d) => d.id !== hub?.id);

    const defs =
      groupBy === "kind"
        ? KIND_DEFS
        : [
            { key: "trusted", label: "Trusted", color: STATUS.trusted.ring },
            { key: "untrusted", label: "Untrusted", color: STATUS.untrusted.ring },
          ];

    const built: GroupLayout[] = defs
      .map((def) => {
        const list = spokes.filter((d) =>
          groupBy === "kind" ? kindKeyOf(d) === def.key : groupKeyOf(d) === def.key
        );
        const isCollapsed = collapsed[def.key] ?? false;
        const cols = Math.min(MAX_COLS, Math.max(1, list.length));
        const rows = Math.ceil(list.length / cols) || 1;
        const w = cols * CELL_W + BOX_PAD * 2;
        const h = isCollapsed ? HEADER_H + 8 : HEADER_H + rows * CELL_H + BOX_PAD;
        return { ...def, devices: list, collapsed: isCollapsed, cols, w, h, x: 0, y: GROUPS_TOP };
      })
      .filter((g) => g.devices.length > 0);

    // Center the row of group boxes horizontally under the gateway. Grow the
    // canvas if they don't fit - grouping by type makes four zones instead of
    // two, which overflowed a fixed width and clipped the leftmost one.
    const totalW = built.reduce((s, g) => s + g.w, 0) + GROUP_GAP * Math.max(0, built.length - 1);
    const width = Math.max(W_MIN, totalW + GROUP_GAP * 2);
    const cx = width / 2;
    let gx = cx - totalW / 2;
    for (const g of built) {
      g.x = gx;
      gx += g.w + GROUP_GAP;
    }

    // Grow the canvas to fit the tallest zone. With a fixed height, a zone with
    // more than MAX_COLS*4 devices ran off the bottom of the viewBox: the rows
    // existed but were unreachable, and "Reset view" put them back out of sight.
    const tallest = built.reduce((m, g) => Math.max(m, g.h), 0);
    const height = Math.max(H_MIN, GROUPS_TOP + tallest + BOX_PAD * 2);

    return { hub, groups: built, onlineCount: online.length, height, width };
  }, [devices, collapsed, showOffline, groupBy]);

  // --- pan / zoom ---------------------------------------------------------
  function toSvg(clientX: number, clientY: number): [number, number] {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return [0, 0];
    return [((clientX - rect.left) * W) / rect.width, ((clientY - rect.top) * H) / rect.height];
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const [sx, sy] = toSvg(e.clientX, e.clientY);
    // Exponential zoom keyed to scroll distance: a mouse-wheel notch (large
    // deltaY) makes a modest step, a trackpad (many small deltas) stays smooth.
    // Clamp per-event so a fast flick can't jump scale in one frame.
    const step = clamp(-e.deltaY * 0.002, -0.25, 0.25);
    const scale = clamp(view.scale * Math.exp(step), 0.5, 3);
    const worldX = (sx - view.tx) / view.scale;
    const worldY = (sy - view.ty) / view.scale;
    setView({ scale, tx: sx - worldX * scale, ty: sy - worldY * scale });
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    moved.current = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const start = drag.current;
    if (!start) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const k = rect && rect.width ? W / rect.width : 1;
    const dx = (e.clientX - start.x) * k;
    const dy = (e.clientY - start.y) * k;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
    // Capture start values - the updater may run after pointerup nulls drag.current.
    setView((v) => ({ ...v, tx: start.tx + dx, ty: start.ty + dy }));
  }
  function onPointerUp() {
    drag.current = null;
  }

  function zoomBy(factor: number) {
    const scale = clamp(view.scale * factor, 0.4, 4);
    // zoom around the map center
    const worldX = (W / 2 - view.tx) / view.scale;
    const worldY = (H / 2 - view.ty) / view.scale;
    setView({ scale, tx: W / 2 - worldX * scale, ty: H / 2 - worldY * scale });
  }
  const resetView = () => setView({ tx: 0, ty: 0, scale: 1 });

  // Suppress the click that ends a pan drag so panning doesn't open the panel.
  const guardedInspect = (d: Device) => {
    if (!moved.current) onInspect?.(d);
  };

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02]">
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">Network map</h2>
          <span className="text-xs text-zinc-500">{onlineCount} online</span>
        </div>
        <div className="flex items-center gap-4">
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
          <button
            onClick={() => setOpen((o) => !o)}
            className="rounded-lg px-2 py-1 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          >
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </header>

      {open &&
        (onlineCount === 0 ? (
          <div className="px-4 pb-6 pt-2 text-center text-sm text-zinc-500">
            No devices online yet - the map fills in as the scan finds them.
          </div>
        ) : (
          <div className="relative">
            {/* zoom controls */}
            <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
              <MapBtn label="+" title="Zoom in" onClick={() => zoomBy(1.2)} />
              <MapBtn label="−" title="Zoom out" onClick={() => zoomBy(1 / 1.2)} />
              <MapBtn label="⤢" title="Reset view" onClick={resetView} />
            </div>
            <span className="pointer-events-none absolute bottom-2 left-4 z-10 text-[11px] text-zinc-500">
              scroll to zoom · drag to pan · click a device to inspect &amp; scan ports
            </span>

            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full cursor-grab touch-none select-none active:cursor-grabbing"
              role="group"
              aria-label={`Network map with ${onlineCount} online devices`}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
                {/* The gateway is the firewall/NAT boundary - everything above
                    this line is outside your control, everything below trusts
                    everything else. Drawn from local facts only: naming a
                    public IP here would mean calling a third-party service,
                    which would break the "no outbound requests" promise. */}
                <line
                  x1={40}
                  y1={BOUNDARY_Y}
                  x2={W - 40}
                  y2={BOUNDARY_Y}
                  stroke="#38bdf8"
                  strokeOpacity={0.25}
                  strokeWidth={1}
                  strokeDasharray="6 6"
                />
                <text x={48} y={BOUNDARY_Y - 7} fontSize={10} fill="#38bdf8" fillOpacity={0.75}>
                  🛡 firewall / NAT - your LAN below
                </text>

                {/* edges: internet → gateway → each zone */}
                <line x1={W / 2} y1={INTERNET_Y} x2={W / 2} y2={GATEWAY_Y} stroke="#ffffff" strokeOpacity={0.12} strokeWidth={1.5} />
                {groups.map((g) => (
                  <line
                    key={`e-${g.key}`}
                    x1={W / 2}
                    y1={GATEWAY_Y}
                    x2={g.x + g.w / 2}
                    y2={g.y}
                    stroke="#ffffff"
                    strokeOpacity={0.1}
                    strokeWidth={1.5}
                  />
                ))}

                {/* Internet / ISP */}
                <TierNode x={W / 2} y={INTERNET_Y} icon="🌐" label={ispName} ring="#64748b" r={26} />

                {/* Gateway */}
                {hub && (
                  <DeviceNode
                    d={hub}
                    x={W / 2}
                    y={GATEWAY_Y}
                    r={30}
                    hover={hover}
                    setHover={setHover}
                    onInspect={guardedInspect}
                  />
                )}

                {/* Zones */}
                {groups.map((g) => (
                  <g key={g.key}>
                    <rect
                      x={g.x}
                      y={g.y}
                      width={g.w}
                      height={g.h}
                      rx={14}
                      fill={g.color}
                      fillOpacity={0.04}
                      stroke={g.color}
                      strokeOpacity={0.35}
                    />
                    <text x={g.x + 14} y={g.y + 24} fontSize={13} fontWeight={600} fill={g.color}>
                      {g.label}
                    </text>
                    <text x={g.x + g.w - 40} y={g.y + 24} fontSize={12} fill="#a1a1aa">
                      {g.devices.length}
                    </text>
                    <g
                      className="cursor-pointer"
                      role="button"
                      tabIndex={0}
                      aria-label={`${g.collapsed ? "Expand" : "Collapse"} ${g.label}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !g.collapsed }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setCollapsed((c) => ({ ...c, [g.key]: !g.collapsed }));
                        }
                      }}
                    >
                      <rect x={g.x + g.w - 26} y={g.y + 10} width={18} height={18} rx={5} fill="#ffffff" fillOpacity={0.06} />
                      <text x={g.x + g.w - 17} y={g.y + 23} fontSize={13} textAnchor="middle" fill="#d4d4d8">
                        {g.collapsed ? "+" : "–"}
                      </text>
                    </g>

                    {!g.collapsed &&
                      g.devices.map((d, i) => {
                        const col = i % g.cols;
                        const row = Math.floor(i / g.cols);
                        const x = g.x + BOX_PAD + col * CELL_W + CELL_W / 2;
                        const y = g.y + HEADER_H + row * CELL_H + CELL_H / 2 - 6;
                        return (
                          <DeviceNode
                            key={d.id}
                            d={d}
                            x={x}
                            y={y}
                            r={22}
                            hover={hover}
                            setHover={setHover}
                            onInspect={guardedInspect}
                          />
                        );
                      })}
                  </g>
                ))}
              </g>
            </svg>
          </div>
        ))}
    </section>
  );
}

function MapBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-sm text-zinc-300 backdrop-blur hover:bg-white/10 hover:text-white"
    >
      {label}
    </button>
  );
}

/** A non-device tier marker (Internet / ISP). */
function TierNode({
  x,
  y,
  icon,
  label,
  ring,
  r,
}: {
  x: number;
  y: number;
  icon: string;
  label: string;
  ring: string;
  r: number;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r} fill="#0b0d12" stroke={ring} strokeWidth={2} opacity={0.9} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={24}>
        {icon}
      </text>
      <text textAnchor="middle" y={r + 15} fontSize={12} fill="#a1a1aa">
        {label}
      </text>
    </g>
  );
}

function DeviceNode({
  d,
  x,
  y,
  r,
  hover,
  setHover,
  onInspect,
}: {
  d: Device;
  x: number;
  y: number;
  r: number;
  hover: string | null;
  setHover: (id: string | null) => void;
  onInspect: (d: Device) => void;
}) {
  const status = statusOf(d);
  const color = STATUS[status].ring;
  const active = hover === d.id;
  const name = displayName(d);
  const scan = scanStatus(d);
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      aria-label={`${name}${d.ip ? `, ${d.ip}` : ""}${d.online === 1 ? "" : ", offline"}${
        scan.status === "risky" ? `, ${scan.riskCount} risky ports` : ""
      } - open details`}
      onMouseEnter={() => setHover(d.id)}
      onMouseLeave={() => setHover(null)}
      onFocus={() => setHover(d.id)}
      onBlur={() => setHover(null)}
      onClick={() => onInspect(d)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onInspect(d);
        }
      }}
    >
      <title>
        {`${name}${d.ip ? ` · ${d.ip}` : ""}` +
          (scan.status === "risky"
            ? ` · ${scan.riskCount} risky port${scan.riskCount > 1 ? "s" : ""}`
            : scan.status === "clean"
              ? " · no risky ports"
              : "")}
      </title>
      <circle
        r={r}
        fill="#0b0d12"
        stroke={color}
        strokeWidth={active ? 3 : 2}
        strokeDasharray={d.online === 1 ? undefined : "3 3"}
        opacity={d.online === 1 ? (active ? 1 : 0.9) : 0.4}
      />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={r > 26 ? 26 : 20}
        opacity={d.online === 1 ? 1 : 0.45}
      >
        {deviceIcon(d)}
      </text>
      {/* exposure badge: red count = risky ports, green ✓ = scanned clean */}
      {scan.status !== "unscanned" && (
        <g transform={`translate(${r * 0.72} ${-r * 0.72})`}>
          <circle r={9} fill={scan.status === "risky" ? "#ef4444" : "#10b981"} stroke="#0b0d12" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={scan.status === "risky" ? 11 : 12} fontWeight={700} fill="#0b0d12">
            {scan.status === "risky" ? scan.riskCount : "✓"}
          </text>
        </g>
      )}
      <text
        textAnchor="middle"
        y={r + 14}
        fontSize={12}
        fill={active ? "#fafafa" : "#a1a1aa"}
        fontWeight={d.is_gateway ? 600 : 400}
      >
        {truncate(name)}
      </text>
    </g>
  );
}
