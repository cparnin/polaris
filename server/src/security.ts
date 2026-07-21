/** Loopback hostnames that may always reach the API. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The whole 127.0.0.0/8 range, matched as an ADDRESS - never as a string prefix.
 *
 * `host.startsWith("127.")` looks equivalent and is not: it also accepts the
 * *hostname* `127.0.0.1.evil.com`, which an attacker can point at loopback,
 * handing them a same-origin read of the entire network map. Public wildcard
 * resolvers (127.0.0.1.nip.io) make that free to set up.
 */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Extract the hostname (dropping any port) from an HTTP Host header. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]")); // [::1]:port -> ::1
  // Bare IPv6 (e.g. "::1") has multiple colons and no port; only "host:port"
  // has exactly one colon to strip.
  if ((h.match(/:/g)?.length ?? 0) > 1) return h;
  return h.split(":")[0]; // host:port -> host
}

/**
 * Is this Host header a loopback address (or an explicitly-allowed host)?
 *
 * Polaris binds to loopback and exposes your whole network map, so we reject any
 * request whose Host header isn't loopback. This is the key defense against
 * DNS-rebinding: a malicious page can point its own domain at 127.0.0.1 and
 * fetch this API from your browser, but the Host header still carries the
 * attacker's domain - which this check refuses. `extra` allows opt-in hosts
 * (via ALLOWED_HOSTS) for anyone who deliberately runs Polaris off-loopback.
 */
export function isLoopbackHost(hostHeader: string, extra: string[] = []): boolean {
  const host = hostnameOf(hostHeader);
  return LOOPBACK_V4.test(host) || LOOPBACK_HOSTS.has(host) || extra.includes(host);
}

/**
 * Is this a same-origin (or origin-less) request?
 *
 * Shipping no CORS stops a cross-origin page from *reading* our responses; it
 * does nothing to stop a **simple** POST from being *sent*. A plain auto-
 * submitting form on any site you visit could hit /api/quit - which shells out
 * to `launchctl bootout` - and silently kill your network monitor until the
 * next login. So mutating routes additionally require that the request either
 * declares no origin at all (curl, same-origin form) or declares a loopback one.
 *
 * `Sec-Fetch-Site` is the reliable signal in modern browsers and is sent even
 * when Origin is omitted; the Origin check covers the rest.
 */
export function isSameOriginRequest(
  headers: { origin?: string; secFetchSite?: string },
  extra: string[] = [],
): boolean {
  const site = headers.secFetchSite;
  // "none" = user-initiated (typed URL, bookmark); "same-origin" = our own page.
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = headers.origin;
  if (!origin || origin === "null") return true; // no Origin to contradict us
  try {
    return isLoopbackHost(new URL(origin).host, extra);
  } catch {
    return false; // unparseable Origin: refuse rather than guess
  }
}
