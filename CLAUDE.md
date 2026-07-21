# Polaris - working notes

Home-network visibility + security tool. Discovers every device on the LAN,
names them, maps the topology, and port-scans them for risky exposure.
Runs entirely on the user's Mac. No cloud, no telemetry.

> The app was renamed from an earlier name that collided with a work app. The
> repo and folder are now `polaris` too; the only survivors are the DB
> rename-migration chain in `db.ts` and the legacy `com.iris.dashboard` label
> that `./polaris uninstall` still boots out. Don't reintroduce the old name.

## Commands

```bash
npm install        # one npm workspace: installs server + web together
npm run build      # compile server (tsc) + bundle dashboard (vite)
npm start          # PRODUCTION: one process serving API + UI on :4000
npm run dev        # DEV: API :4000 + Vite dashboard :5173, hot reload
npm test           # both workspaces: server (node:test) + web (vitest)
```

## How it runs day to day

It auto-starts at login as a macOS LaunchAgent **`com.polaris.dashboard`**
(`./polaris install` writes the plist → `scripts/polaris-start.sh`), running the lean
production build: **a single ~80MB Node process on http://127.0.0.1:4000**.

- **`./polaris` (repo root) is the start/stop switch:**
  `./polaris` (status) · `start` · `stop` · `restart` · `rebuild` · `logs` ·
  `open` · `install` · `uninstall`. It's the only control script - it wraps the
  `launchctl gui/$(id -u)/...` syntax. Never call `launchctl` directly.
- **Production is NOT hot-reload.** After changing code: **`./polaris rebuild`**
  (= `npm run build` + restart).
- **Don't run `scripts/polaris-start.sh` by hand** - it's the launchd wrapper.
  launchd already holds :4000, so a manual run hits `EADDRINUSE`. It now detects
  that and exits cleanly instead of throwing a stack trace that looks like a crash.
- Logs: `~/Library/Logs/polaris-dashboard.log` (+ `.err.log`)
- The UI also has **⏸ Pause** (stop scanning) and **⏻ Quit** (stop everything).
- **A heartbeat push goes out every `HEARTBEAT_DAYS` (default 7).** Without it,
  a dead Polaris and a quiet network look identical: both send nothing. The
  timestamp lives in the `meta` table so restarts neither re-send nor lose it.
- New devices are auto port-scanned on arrival (`AUTOSCAN_NEW_DEVICES=0` to
  disable), and the finding is folded into the ntfy alert.

## Definition of done

No change is finished until all of these are true. Don't ask whether to do them
- they are the baseline, not an upsell.

1. **Tests.** Add or update tests for the behavior you changed. `npm test` passes.
2. **Docs.** Update `README.md` and this file if behavior, commands, env vars,
   file layout, or endpoints changed. A doc that describes a deleted script is a
   bug - grep for the old name before you call it done.
3. **Security.** Re-read the security posture below against your change. Any new
   route, input, or shell/network call gets validated at the boundary.
4. **Verify for real.** Build it and drive it (`./polaris rebuild`, then the
   browser or curl). Tests passing is not the same as the app working.
5. **Keep it lean.** No new dependency without a clear reason - see Conventions.
6. **Commit and push.** Every time, without being asked. Small, focused commits
   with a message that says why. Push to `origin`.

## Gotchas that have bitten before

- **`.env` is loaded by `server/src/env.ts`, imported FIRST in `index.ts`.**
  Modules read `process.env` at evaluation time, so that import must stay first.
  Before this existed, `.env` was silently ignored - ntfy never fired for days.
- **HTTP header values must be Latin-1.** `notify.ts` runs titles through
  `headerSafe()`; an emoji in a header throws and the notification dies
  silently. Device names come off the network, so it also strips CR/LF.
- **Env values that reach a timer or SQLite are validated in `config.ts`.**
  `SCAN_INTERVAL_MS` needs BOTH a floor and a ceiling: `NaN` coerces to a 0ms
  interval, and a value past 2^31-1 overflows the timer back down to 1ms - same
  runaway, opposite end. `EVENT_RETENTION` reaching SQLite as `NaN` throws
  inside `pruneEvents`, which runs at the TOP of every scan, so one bad line
  means no scan ever finishes and no alert ever fires.
- **Bitwise IP math must parenthesize the unsigned coercion.** `>>>` binds
  tighter than `===`, so `a & mask === b & mask >>> 0` only coerces one side;
  `&` returns a signed int32, so any network with a first octet >= 128 (i.e.
  192.168.x and 172.16.x) never matches. That silently hid every ARP-known host
  that doesn't answer ICMP. Correct versions: `discover.ts:inSubnet` and
  `portscan.ts:assertInSubnet`.
- **Browser caches the content-hashed bundle.** After a rebuild, hard-reload or
  append `?v=N`, or you'll debug stale JS.
- **Device identity:** `id` is the MAC, falling back to `ip:<addr>` when the MAC
  isn't in the ARP cache yet. That produces duplicate "ghost" rows, so
  `applyScan` sweeps `ip:` rows that duplicate a MAC row at the same IP.
- **macOS `arp -an` strips leading zeros per octet** (`44:7:b:e5:19:84`).
  `normalizeMac` has to pad them; the old "strip separators, require 12 hex
  chars" rejected ~a third of a real network, so those devices had no MAC, no
  vendor, and no stable id - which is where most ghost rows came from.
- **Discovery is ARP-first, not ping-first.** A UDP poke to each address makes
  the kernel resolve its MAC; we then read `arp -an`. Don't reintroduce a
  per-host ping sweep - it was 1022 subprocesses per scan on a /22 and found
  *fewer* devices. `ping` now runs only for hosts with no OS guess yet.
- **Scan time is dominated by naming, not discovery.** Devices that answer no
  naming protocol must not be re-queried every scan (`triedUnnamed`); their
  fixed mDNS/NetBIOS/DNS timeouts were most of the scan.
- **DB is `data/polaris.sqlite`**, with a rename-migration chain from earlier
  names. Port-scan results persist on the device row (`open_ports`,
  `risk_count`, `last_portscan_at`) and never expire.
- Watch for **orphaned dev processes** after restarts (`lsof -nP -iTCP:4000`).

## Conventions

- **No em dashes anywhere.** Not in code comments, docs, commit messages, UI
  copy, or replies. Use a comma, a colon, parentheses, or a plain hyphen. This
  applies to text written for this repo and to anything written about it.
- **Prefer zero dependencies.** The mDNS, NetBIOS and .env parsers are all
  hand-rolled on purpose; node_modules size is a standing concern.
- Server tests use the **built-in `node:test`** runner; web uses **Vitest +
  Testing Library**. Node's runner isolates each file in its own process, which
  is how DB tests each get a clean `POLARIS_DATA_DIR`.
- Port-scan **risk rules live in `net/portscan.ts` (`riskFor`)** and are
  deliberately conservative - normal consumer ports (Chromecast 8008/8009/8443,
  IPP, Kasa 9999) must stay unflagged so a badge means something. There are
  tests asserting those stay clean.
- Verify UI changes by actually driving the app in a browser, not just tests.

## Security posture

Binds to loopback only, rejects non-loopback `Host` headers (DNS-rebinding
defense), and ships **no CORS** - the dashboard is same-origin. Port scans are
opt-in, per-device, and refuse to scan outside the local subnet.

Two traps that were live bugs, both in `security.ts` - read it before touching
the middleware in `index.ts`:

- **Match loopback as an ADDRESS, never a string prefix.** `startsWith("127.")`
  also accepts the *hostname* `127.0.0.1.evil.com`, which an attacker points at
  loopback for a same-origin read of the whole network map. `127.0.0.1.nip.io`
  resolves publicly, so it costs them nothing. Tests pin this.
- **No CORS is not a CSRF defense.** It stops other origins *reading* replies,
  not *sending* simple POSTs. `/api/quit` shells out to `launchctl bootout`, so
  an auto-submitting form on any page could kill the monitor until next login.
  Mutating verbs go through `isSameOriginRequest` (Origin + `Sec-Fetch-Site`).

Anything reachable from the network is untrusted input: validate at the
boundary, and keep hostile-input parsing O(bytes received) - the mDNS/NetBIOS
parsers share the single thread that serves the API.
