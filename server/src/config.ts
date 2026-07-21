/**
 * Env-value parsing for settings that can wedge the daemon if they're wrong.
 *
 * These live here rather than inline at each use site so they can be tested
 * without booting the server. Every one of them has a real failure story:
 * a bad SCAN_INTERVAL_MS once meant back-to-back scanning forever, and a bad
 * EVENT_RETENTION makes pruneEvents() throw on every scan - which aborts the
 * scan before notifications run, so the dashboard just quietly goes stale.
 */

/** setInterval/setTimeout silently coerce anything past this to 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

export interface ResolvedValue<T> {
  value: T;
  /** Set when the raw input was rejected - callers log this. */
  warning?: string;
}

/**
 * Scan cadence, clamped to a sane range.
 *
 * Needs a ceiling as well as a floor: an extra-zeros typo (3000000000)
 * overflows the timer and lands back at a 1ms interval - the exact runaway the
 * floor exists to prevent, entered from the other end.
 */
export function resolveInterval(raw: string | undefined, fallback = 300_000): ResolvedValue<number> {
  if (raw === undefined) return { value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10_000 || n > MAX_TIMER_MS) {
    return {
      value: fallback,
      warning: `ignoring invalid SCAN_INTERVAL_MS=${JSON.stringify(raw)}; using ${fallback}ms`,
    };
  }
  return { value: n };
}

/**
 * A positive whole number from the environment, or the fallback.
 *
 * Guards against the whole family of near-miss values - "5000  # keep 5k"
 * (pre-fix .env parsing), "", "abc", "-1", "1e999", 3.7 - any of which would
 * otherwise reach SQLite as NaN/float and throw "datatype mismatch" at bind time.
 */
export function resolveCount(
  name: string,
  raw: string | undefined,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
): ResolvedValue<number> {
  if (raw === undefined) return { value: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      value: fallback,
      warning: `ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`,
    };
  }
  return { value: n };
}

/** Apply a resolved value, logging any warning once at startup. */
export function applyResolved<T>(r: ResolvedValue<T>): T {
  if (r.warning) console.warn(`[config] ${r.warning}`);
  return r.value;
}
