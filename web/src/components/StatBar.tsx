import type { Device } from "../api.js";

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className={`text-2xl font-bold tabular-nums ${accent ?? "text-white"}`}>{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

export function StatBar({ devices, loading }: { devices: Device[]; loading?: boolean }) {
  const online = devices.filter((d) => d.online === 1).length;
  const untrusted = devices.filter((d) => d.trusted === 0 && d.online === 1).length;
  const randomized = devices.filter((d) => d.randomized === 1).length;

  // Before the first scan lands there is no "0 devices online" - there is no
  // answer yet. These are the largest numbers on the page; showing a confident
  // zero reads as "your network is empty", which is a lie with good posture.
  const show = (n: number): string | number => (loading ? "-" : n);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Online now" value={show(online)} accent="text-emerald-400" />
      <Stat label="Known total" value={show(devices.length)} />
      <Stat
        label="Untrusted online"
        value={show(untrusted)}
        accent={!loading && untrusted > 0 ? "text-amber-400" : "text-white"}
      />
      <Stat label="Privacy MACs" value={show(randomized)} accent="text-sky-400" />
    </div>
  );
}
