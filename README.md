<div align="center">

<img src="./assets/hero.svg" alt="Polaris - god-mode for your home network" width="100%" />

# ✦ Polaris

**God-mode visibility over your home network.** Discovers every device on your LAN,
tells you who's online, names them, and pings your phone the moment something new
shows up - no router login, no agents on your devices, runs entirely on your Mac.

![phase](https://img.shields.io/badge/phase-2%20visibility%20%2B%20alerts-34d399)
![node](https://img.shields.io/badge/node-20%2B-3c9863)
![local-only](https://img.shields.io/badge/API-localhost--only-7dd3fc)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## What it does

- **Fast discovery** - ARP-first sweep across your whole subnet: one UDP socket
  nudges every address so the kernel resolves its MAC, then Polaris reads the ARP
  table. A /22 in ~2.5s, no `sudo`, and no subprocesses. It finds devices that
  ignore ICMP entirely - Windows boxes behind the default firewall, locked-down
  IoT gear - which a ping sweep misses.
- **Real device names** - resolves friendly names from four sources so fewer
  devices show up generic: mDNS **service discovery** (Chromecast/Nest, Apple TV,
  Sonos, HomeKit, printers), reverse **mDNS** `.local` names, **NetBIOS** machine
  names (Windows / NAS / Samba), and reverse DNS. Re-checked periodically so
  renamed or newly-woken devices get their name.
- **Vendor identification** - bundled offline IEEE/Wireshark OUI database (~40k
  prefixes): Apple, Google, eero, TP-Link, Canon, Espressif, and thousands more.
  Binary-searched from a flat file, so it costs ~1MB of memory rather than 14MB.
- **OS hint** - coarse OS family guess (Windows / Apple·Linux·Android / Router·IoT)
  from reply TTL, so a stray Windows box stands out.
- **Privacy-MAC detection** - flags devices using randomized MACs (modern phones).
- **New-device alerts** - **ntfy** push to your phone the instant an unknown device
  joins. New arrivals are auto-fingerprinted, so the alert says what the device is
  *exposing* ("New device (2 risky ports): sketchy-nas"), not just that it appeared.
  Untrusted-online count is surfaced front-and-center.
- **Naming & trust** - rename any device, mark devices trusted.
- **Pause / off switch** - **⏸ Pause** halts scanning (and its CPU/network use)
  while keeping the dashboard live; **⏻ Quit** stops Polaris entirely from the header.
- **Network map** - live tiered topology: Internet / ISP → your gateway → the
  LAN, with devices clustered into Trusted / Untrusted zones. Scroll to zoom,
  drag to pan, collapse a zone, and click a device to inspect it.
- **Port & service scan** - click a device (on the map or its card) to run an
  opt-in `nmap` scan of the top 200 ports, followed by a best-effort `-sV`
  version probe: open ports, detected services, and risky-exposure flags
  (SMB, RDP, Telnet, VNC). Results persist and badge the map node by exposure
  (green ✓ = scanned clean, red count = risky ports) so the whole map reads as a
  live security view.
- **Live everything** - real-time (SSE) activity feed; auto-rescan on an interval.
- **History** - everything persists in SQLite and survives restarts.

## Security model

Polaris sees your entire home network, so it's built to stay yours:

- **The API binds to `127.0.0.1` only.** It is never reachable from the LAN by
  default - the device inventory it exposes stays on your machine.
- **DNS-rebinding guard.** Every request must carry a loopback `Host` header, so
  a malicious web page can't point its own domain at `127.0.0.1` and read your
  network map from your browser. There is **no wide-open CORS** - the dashboard
  talks to the API same-origin, so none is needed.
- **No telemetry, no cloud.** The only outbound request Polaris ever makes is the
  ntfy push you explicitly configure (and MAC-vendor lookups are fully offline).
- **Your device database never leaves your machine** - `data/` is git-ignored.
- Override the bind address with `HOST=0.0.0.0` only if you know what you're doing
  and are putting auth in front of it; add your hostname to `ALLOWED_HOSTS` so the
  Host guard still lets you in.

## Requirements

- macOS (uses `route`, `ifconfig`, `arp`, `ping`)
- Node.js 20+ (built on 24)
- **`nmap`** - optional, but port/service scanning does nothing without it.
  Install with `brew install nmap`. Everything else (discovery, naming, the map,
  alerts) works fine without it; the scan button just reports it's missing.

## Quick start

**Production (lean - one process, ~80MB, recommended for everyday use):**

```bash
npm install       # one npm workspace - installs server + web together
npm run build     # compile the server + bundle the dashboard
npm start         # serves API + dashboard on http://127.0.0.1:4000
```

Open **http://localhost:4000**. One Node process serves everything - no Vite dev
server, no bundler, no file-watchers. Re-run `npm run build` after code changes.

**Development (hot-reload while hacking on Polaris, ~200MB):**

```bash
npm run dev       # API on :4000, Vite dashboard on :5173 (edits reload live)
```

Open **http://localhost:5173**. The first scan runs automatically and repeats
every 5 minutes (tune with `SCAN_INTERVAL_MS`). Hit **Scan now** anytime for an
on-demand refresh, or use **⏸ Pause** / **⏻ Quit** in the header.

### Keep it running (auto-start on login)

On macOS, install a LaunchAgent so Polaris starts at login and restarts if it
crashes. It runs the lean production build (builds once if needed):

```bash
./polaris install     # install (once)
./polaris uninstall   # remove entirely
```

Day to day, `./polaris` in the repo root is the whole interface:

```bash
./polaris            # is it running?
./polaris stop       # turn it off (stays off until you start it)
./polaris start      # turn it back on
./polaris restart    # pick up changes after `npm run build`
./polaris rebuild    # build + restart, in one step
./polaris logs       # tail the log
./polaris open       # open the dashboard in a browser
```

That's the whole interface - it drives the LaunchAgent for you.

Logs go to `~/Library/Logs/polaris-dashboard.log`.

## Notifications (ntfy)

Point Polaris at any [ntfy](https://ntfy.sh) topic (public or self-hosted). Use a
**long, unguessable topic name** - anyone who knows a public topic can read it.

```bash
# .env (see .env.example) - loaded automatically at startup
NTFY_URL=https://ntfy.sh/polaris-home-8fk39dk2mx7
# NTFY_TOKEN=tk_...        # optional, for protected/self-hosted servers
# NTFY_PRIORITY=high       # optional default priority
```

`.env` in the repo root is read on startup for both dev and production; real
environment variables take precedence over it.

Subscribe to that topic in the ntfy app on your phone, then click **“alerts on”**
in the header to fire a test push. New devices trigger a notification automatically
(the very first baseline scan is suppressed so you aren't buried on day one).

## Configuration

| Env var            | Default       | Meaning                                   |
| ------------------ | ------------- | ----------------------------------------- |
| `HOST`             | `127.0.0.1`   | Bind address (keep loopback unless auth'd)|
| `PORT`             | `4000`        | Backend HTTP port                         |
| `SCAN_INTERVAL_MS` | `300000`      | Auto-scan interval (5 min). Must be 10000–2147483647; anything else falls back to the default with a warning in the log |
| `NAME_REFRESH_EVERY`| `6`          | Full name re-resolve every Nth scan       |
| `EVENT_RETENTION`  | `5000`        | Max activity-log rows kept (older pruned). Must be a positive integer |
| `NTFY_URL`         | *(unset)*     | ntfy topic URL; unset = alerts off        |
| `NTFY_TOKEN`       | *(unset)*     | ntfy bearer token (optional)              |
| `NTFY_PRIORITY`    | `default`     | default ntfy priority                     |
| `ALLOWED_HOSTS`    | *(unset)*     | extra Host headers allowed (off-loopback) |
| `ISP_NAME`         | `Internet / ISP` | label for the upstream node on the map |
| `AUTOSCAN_NEW_DEVICES` | `1`       | port-scan new devices on arrival (`0` = off) |
| `AUTOSCAN_MAX_PER_SCAN` | `3`      | cap auto-scans per scan cycle             |
| `POLARIS_DATA_DIR` | `./data`      | where the SQLite database lives           |
| `POLARIS_ENV_FILE` | `./.env`      | override which env file is loaded          |
| `POLARIS_LAUNCHD_LABEL` | `com.polaris.dashboard` | LaunchAgent label used by ⏻ Quit |

## Architecture

```
server/  Node + TypeScript
  net/subnet.ts    detect active interface + CIDR from the default route
  net/discover.ts  parallel ping-sweep, ARP read, TTL OS hint, cached enrichment
  net/mdns.ts      hand-rolled reverse-mDNS + service-discovery resolver
  net/netbios.ts   NetBIOS node-status names (Windows / NAS / Samba)
  net/vendors.ts   MAC → vendor via bundled OUI DB
  net/portscan.ts  opt-in nmap -sV service scan + risky-exposure rules
  db.ts            SQLite (polaris.sqlite): devices + events (auto-pruned), scan diffing
  notify.ts        ntfy push notifications (new-device alerts with findings)
  security.ts      loopback Host-header guard (DNS-rebinding defense)
  env.ts           loads .env before anything reads process.env
  scanner.ts       scan orchestration + auto-scan loop + event bus
  index.ts         Express REST API + Server-Sent-Events stream (localhost)
  *.test.ts        unit tests (node:test) for parsing + network + security logic
web/     Vite + React 19 + Tailwind v4 dashboard
  components/NetworkMap.tsx        tiered topology, zoom/pan, exposure badges
  components/DeviceDetailPanel.tsx click-to-inspect drawer + port scan
  components/DeviceCard.tsx        device grid card (rename, trust, scan)
polaris  start/stop/restart/rebuild/status/logs - the one control script
scripts/ autostart install/uninstall + the launchd start wrapper
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
| DELETE | `/api/devices/:id`   | forget a device and its history  |
| POST   | `/api/devices/:id/portscan` | nmap service scan of one device |
| POST   | `/api/pause` · `/api/resume` | pause / resume auto-scanning |
| POST   | `/api/quit`          | stop Polaris entirely (⏻ Quit)   |
| GET    | `/api/stream`        | SSE: scan lifecycle events       |

## Tests

```bash
npm test        # runs both workspaces: server (node:test) + web (vitest)
```

- **Server** (`node:test`, no extra deps): MAC/vendor normalization, subnet math,
  the hand-rolled mDNS + NetBIOS packet parsers, and the loopback Host-header guard.
- **Web** (Vitest + Testing Library): device naming/icon logic and the network-map
  component render + interaction.

No real network or database is touched, so the suite is fast and deterministic.

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Next up: richer names for Chromecast/Nest via mDNS
service-discovery, port-scan fingerprinting, and (with router/Pi-hole integration)
per-device bandwidth and one-click blocking.

## Honest limitations

- **Per-device bandwidth** and **hard blocking** aren't possible from a LAN host
  alone - they need router integration (UniFi, pfSense, OpenWrt) or Pi-hole. Tracked
  in the roadmap.
- **mDNS names are best-effort** - devices that don't answer reverse mDNS show their
  vendor + IP instead. Chromecast/Nest friendly names need service-discovery (roadmap).
- Devices that block ICMP and aren't in the ARP cache may be missed on a given scan;
  they appear once any traffic populates the ARP table.

## License

MIT © [cparnin](https://github.com/cparnin)
