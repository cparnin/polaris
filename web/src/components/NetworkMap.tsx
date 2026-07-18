import { useMemo, useState } from "react";
import type { Device } from "../api.js";
import { displayName } from "../api.js";
import { deviceIcon } from "../deviceMeta.js";

/** Status → ring color + legend label. Also encoded by position + icon, so the
 *  map never relies on color alone. */
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

interface Placed {
  d: Device;
  x: number;
  y: number;
  status: Status;
}

const W = 820;
const H = 520;
const CX = W / 2;
const CY = H / 2;

function ring(list: Device[], radius: number, offset = 0): Placed[] {
  const n = list.length || 1;
  return list.map((d, i) => {
    const angle = -Math.PI / 2 + offset + (2 * Math.PI * i) / n;
    return {
      d,
      x: CX + radius * Math.cos(angle),
      y: CY + radius * Math.sin(angle),
      status: statusOf(d),
    };
  });
}

function truncate(s: string, n = 16): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Live hub-and-spoke view of the network: the gateway at the center, every
 * online device orbiting it, colored by trust status. Click a node to filter
 * the device list to it.
 */
export function NetworkMap({
  devices,
  onSelect,
}: {
  devices: Device[];
  onSelect?: (d: Device) => void;
}) {
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState<string | null>(null);

  const { hub, nodes } = useMemo(() => {
    const online = devices.filter((d) => d.online === 1);
    const hub = online.find((d) => d.is_gateway) ?? null;
    const spokes = online.filter((d) => d.id !== hub?.id);
    // One ring up to 12 nodes; split into two concentric rings beyond that.
    if (spokes.length <= 12) {
      return { hub, nodes: ring(spokes, 175) };
    }
    const half = Math.ceil(spokes.length / 2);
    return {
      hub,
      nodes: [
        ...ring(spokes.slice(0, half), 120),
        ...ring(spokes.slice(half), 205, Math.PI / half),
      ],
    };
  }, [devices]);

  const onlineCount = nodes.length + (hub ? 1 : 0);

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02]">
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">Network map</h2>
          <span className="text-xs text-zinc-500">{onlineCount} online</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-3 sm:flex">
            {Object.entries(STATUS).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: v.ring }} />
                {v.label}
              </span>
            ))}
          </div>
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
            No devices online yet — the map fills in as the scan finds them.
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full select-none"
            role="img"
            aria-label={`Network map with ${onlineCount} online devices`}
          >
            {/* spokes */}
            {nodes.map((n) => (
              <line
                key={`l-${n.d.id}`}
                x1={CX}
                y1={CY}
                x2={n.x}
                y2={n.y}
                stroke="#ffffff"
                strokeOpacity={hover === n.d.id ? 0.28 : 0.08}
                strokeWidth={1.5}
              />
            ))}

            {hub && <MapNode node={{ d: hub, x: CX, y: CY, status: "gateway" }} hub hover={hover} setHover={setHover} onSelect={onSelect} />}
            {nodes.map((n) => (
              <MapNode key={n.d.id} node={n} hover={hover} setHover={setHover} onSelect={onSelect} />
            ))}
          </svg>
        ))}
    </section>
  );
}

function MapNode({
  node,
  hub = false,
  hover,
  setHover,
  onSelect,
}: {
  node: Placed;
  hub?: boolean;
  hover: string | null;
  setHover: (id: string | null) => void;
  onSelect?: (d: Device) => void;
}) {
  const { d, x, y, status } = node;
  const r = hub ? 34 : 24;
  const active = hover === d.id;
  const color = STATUS[status].ring;
  const name = displayName(d);

  return (
    <g
      transform={`translate(${x} ${y})`}
      className="cursor-pointer"
      onMouseEnter={() => setHover(d.id)}
      onMouseLeave={() => setHover(null)}
      onClick={() => onSelect?.(d)}
    >
      <title>{`${name}${d.ip ? ` · ${d.ip}` : ""}`}</title>
      <circle
        r={r}
        fill="#0b0d12"
        stroke={color}
        strokeWidth={active ? 3 : 2}
        opacity={active ? 1 : 0.9}
      />
      <text textAnchor="middle" dominantBaseline="central" fontSize={hub ? 30 : 22}>
        {deviceIcon(d)}
      </text>
      <text
        textAnchor="middle"
        y={r + 15}
        fontSize={12}
        fill={active ? "#fafafa" : "#a1a1aa"}
        fontWeight={hub ? 600 : 400}
      >
        {truncate(name)}
      </text>
    </g>
  );
}
