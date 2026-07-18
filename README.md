<div align="center">

<img src="./assets/hero.svg" alt="Iris — god-mode for your home network" width="100%" />

# 👁️ Iris

**God-mode visibility over your home network.** Discovers every device on your LAN,
tells you who's online, names them, and pings your phone the moment something new
shows up — no router login, no agents on your devices, runs entirely on your Mac.

![phase](https://img.shields.io/badge/phase-2%20visibility%20%2B%20alerts-34d399)
![node](https://img.shields.io/badge/node-20%2B-3c9863)
![local-only](https://img.shields.io/badge/API-localhost--only-7dd3fc)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## What it does

- **Fast discovery** — parallel ICMP ping-sweep + ARP-cache read across your whole
  subnet. A /24 in ~2s, a /22 in ~8s. No `sudo`.
- **Real device names** — resolves friendly names from four sources so fewer
  devices show up generic: mDNS **service discovery** (Chromecast/Nest, Apple TV,
  Sonos, HomeKit, printers), reverse **mDNS** `.local` names, **NetBIOS** machine
  names (Windows / NAS / Samba), and reverse DNS. Re-checked periodically so
  renamed or newly-woken devices get their name.
- **Vendor identification** — bundled offline IEEE/Wireshark OUI database (~40k
  prefixes): Apple, Google, eero, TP-Link, Canon, Espressif, and thousands more.
- **OS hint** — coarse OS family guess (Windows / Apple·Linux·Android / Router·IoT)
  from reply TTL, so a stray Windows box stands out.
- **Privacy-MAC detection** — flags devices using randomized MACs (modern phones).
- **New-device alerts** — **ntfy** push to your phone the instant an unknown device
  joins. Untrusted-online count is surfaced front-and-center.
- **Naming & trust** — rename any device, mark devices trusted.
- **Live everything** — real-time (SSE) activity feed; auto-rescan on an interval.
- **History** — everything persists in SQLite and survives restarts.

## Security model

Iris sees your entire home network, so it's built to stay yours:

- **The API binds to `127.0.0.1` only.** It is never reachable from the LAN by
  default — the device inventory it exposes stays on your machine.
- **DNS-rebinding guard.** Every request must carry a loopback `Host` header, so
  a malicious web page can't point its own domain at `127.0.0.1` and read your
  network map from your browser. There is **no wide-open CORS** — the dashboard
  talks to the API same-origin, so none is needed.
- **No telemetry, no cloud.** The only outbound request Iris ever makes is the
  ntfy push you explicitly configure (and MAC-vendor lookups are fully offline).
- **Your device database never leaves your machine** — `data/` is git-ignored.
- Override the bind address with `HOST=0.0.0.0` only if you know what you're doing
  and are putting auth in front of it; add your hostname to `ALLOWED_HOSTS` so the
  Host guard still lets you in.

## Requirements

- macOS (uses `route`, `ifconfig`, `arp`, `ping`)
- Node.js 20+ (built on 24)

## Quick start

```bash
npm run install:all   # install root + server + web deps
npm run dev           # backend on 127.0.0.1:4000, dashboard on :5173
```

Open **http://localhost:5173**. The first scan runs automatically and repeats
every 5 minutes (tune with `SCAN_INTERVAL_MS`). Hit **Scan now** anytime for an
on-demand refresh.

### Keep it running (auto-start on login)

On macOS, install a LaunchAgent so Iris starts at login and restarts if it
crashes:

```bash
./scripts/install-autostart.sh     # enable
./scripts/uninstall-autostart.sh   # disable
```

Logs go to `~/Library/Logs/iris-dashboard.log`.

## Notifications (ntfy)

Point Iris at any [ntfy](https://ntfy.sh) topic (public or self-hosted). Use a
**long, unguessable topic name** — anyone who knows a public topic can read it.

```bash
# .env (see .env.example)
NTFY_URL=https://ntfy.sh/iris-home-8fk39dk2mx7
# NTFY_TOKEN=tk_...        # optional, for protected/self-hosted servers
# NTFY_PRIORITY=high       # optional default priority
```

Subscribe to that topic in the ntfy app on your phone, then click **“alerts on”**
in the header to fire a test push. New devices trigger a notification automatically
(the very first baseline scan is suppressed so you aren't buried on day one).

## Configuration

| Env var            | Default       | Meaning                                   |
| ------------------ | ------------- | ----------------------------------------- |
| `HOST`             | `127.0.0.1`   | Bind address (keep loopback unless auth'd)|
| `PORT`             | `4000`        | Backend HTTP port                         |
| `SCAN_INTERVAL_MS` | `300000`      | Auto-scan interval (5 min)                |
| `NAME_REFRESH_EVERY`| `6`          | Full name re-resolve every Nth scan       |
| `EVENT_RETENTION`  | `5000`        | Max activity-log rows kept (older pruned) |
| `NTFY_URL`         | *(unset)*     | ntfy topic URL; unset = alerts off        |
| `NTFY_TOKEN`       | *(unset)*     | ntfy bearer token (optional)              |
| `NTFY_PRIORITY`    | `default`     | default ntfy priority                     |
| `ALLOWED_HOSTS`    | *(unset)*     | extra Host headers allowed (off-loopback) |
| `IRIS_DATA_DIR`    | `./data`      | where the SQLite database lives           |

## Architecture

```
server/  Node + TypeScript
  net/subnet.ts    detect active interface + CIDR from the default route
  net/discover.ts  parallel ping-sweep, ARP read, TTL OS hint, cached enrichment
  net/mdns.ts      hand-rolled reverse-mDNS + service-discovery resolver
  net/netbios.ts   NetBIOS node-status names (Windows / NAS / Samba)
  net/vendors.ts   MAC → vendor via bundled OUI DB
  db.ts            SQLite (iris.sqlite): devices + events (auto-pruned), scan diffing
  notify.ts        ntfy push notifications
  security.ts      loopback Host-header guard (DNS-rebinding defense)
  scanner.ts       scan orchestration + auto-scan loop + event bus
  index.ts         Express REST API + Server-Sent-Events stream (localhost)
  *.test.ts        unit tests (node:test) for parsing + network + security logic
web/     Vite + React + Tailwind v4 dashboard
```

### API (localhost only)

| Method | Path                 | Purpose                          |
| ------ | -------------------- | -------------------------------- |
| GET    | `/api/devices`       | all known devices + last scan    |
| GET    | `/api/events`        | recent activity events           |
| GET    | `/api/health`        | status + ntfy config (redacted)  |
| POST   | `/api/scan`          | trigger a scan now               |
| POST   | `/api/notify/test`   | send a test ntfy push            |
| PATCH  | `/api/devices/:id`   | set `label` / `trusted`          |
| GET    | `/api/stream`        | SSE: scan lifecycle events       |

## Tests

```bash
npm test        # runs the server suite (Node's built-in runner, no extra deps)
```

Covers the fiddly, easy-to-break logic: MAC/vendor normalization, subnet math,
the hand-rolled mDNS + NetBIOS packet parsers, and the loopback Host-header
guard. No network or database is touched, so the suite is fast and deterministic.

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Next up: richer names for Chromecast/Nest via mDNS
service-discovery, port-scan fingerprinting, and (with router/Pi-hole integration)
per-device bandwidth and one-click blocking.

## Honest limitations

- **Per-device bandwidth** and **hard blocking** aren't possible from a LAN host
  alone — they need router integration (UniFi, pfSense, OpenWrt) or Pi-hole. Tracked
  in the roadmap.
- **mDNS names are best-effort** — devices that don't answer reverse mDNS show their
  vendor + IP instead. Chromecast/Nest friendly names need service-discovery (roadmap).
- Devices that block ICMP and aren't in the ARP cache may be missed on a given scan;
  they appear once any traffic populates the ARP table.

## License

MIT © [cparnin](https://github.com/cparnin)
