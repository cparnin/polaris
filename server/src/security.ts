/** Loopback hostnames that may always reach the API. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

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
 * Iris binds to loopback and exposes your whole network map, so we reject any
 * request whose Host header isn't loopback. This is the key defense against
 * DNS-rebinding: a malicious page can point its own domain at 127.0.0.1 and
 * fetch this API from your browser, but the Host header still carries the
 * attacker's domain — which this check refuses. `extra` allows opt-in hosts
 * (via ALLOWED_HOSTS) for anyone who deliberately runs Iris off-loopback.
 */
export function isLoopbackHost(hostHeader: string, extra: string[] = []): boolean {
  const host = hostnameOf(hostHeader);
  return host.startsWith("127.") || LOOPBACK_HOSTS.has(host) || extra.includes(host);
}
