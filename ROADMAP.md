# cap-network roadmap

A phased path from "see everything" to "control everything." Phase 1 is built.

---

## ✅ Phase 1 — Visibility (done)

Know your network. Device discovery, vendor ID, online/offline status, new-device
alerts, naming, trust, activity history. See [README](./README.md).

---

## 🔶 Phase 2 — Security watchdog (in progress)

Turn passive visibility into active awareness. All achievable from the Mac, no
router access needed.

- ✅ **New-device notifications** — ntfy push when a device joins (baseline scan
  suppressed). Discord/webhook targets can be added the same way.
- ✅ **Real device names (reverse mDNS)** — friendly `.local` hostnames for devices
  that answer; router/printer/Mac/iPhone names without any router login.
- ✅ **Coarse OS hint** — Windows / Apple·Linux·Android / Router·IoT from reply TTL.
- ✅ **Richer names for casted devices** — mDNS *service* discovery (`_googlecast`,
  `_airplay`, `_raop`, `_hap`, `_sonos`, printers) surfaces the friendly names you
  set on Chromecast/Nest, Apple TV, HomeKit, Sonos, and printers.
- **Port & service scan** — opt-in `nmap -sV` on discovered hosts to fingerprint open
  ports and running services; flag risky exposure (open SMB, RDP, Telnet, UPnP).
- **Rogue-device heuristics** — detect MAC spoofing (same IP, changing MAC), ARP
  anomalies, and devices impersonating the gateway (ARP-spoof / MITM detection).
- **Presence patterns** — learn each device's normal online hours; alert on anomalies
  ("the office printer came online at 3am").
- **OS / device fingerprinting** — TTL + TCP-stack + mDNS/SSDP enrichment for better
  names and types than MAC vendor alone.
- **mDNS/SSDP/Bonjour crawl** — actively enumerate advertised services (`_airplay`,
  `_googlecast`, `_hap` HomeKit, etc.) for rich device identity.

Data model already supports this: `events` table + `trusted` flag + per-device history.

---

## 🔷 Phase 3 — Control

Where "god mode" gets teeth. **Capability depends on gear** — this is where a basic
router limits us, so the phase is tiered:

### Tier A — works on any network (LAN-host techniques)
- **Wake-on-LAN** — wake devices by MAC.
- **Scheduled scans & reports** — nightly network digest, weekly new-device summary.
- **DNS-level control via built-in resolver** — run a small DNS forwarder devices can
  point at, with per-device block/allow lists (opt-in; requires devices to use it).
- **ARP-based isolation (advanced, opt-in)** — quarantine a device by ARP manipulation.
  Powerful but intrusive; ships behind an explicit "I understand" toggle.

### Tier B — needs router/gateway integration (recommended upgrade path)
Pick whichever you have; each unlocks *real* control:
- **UniFi / Ubiquiti** — official API: true per-client bandwidth, block/unblock, QoS,
  per-SSID rules, real-time throughput. **Best experience.**
- **pfSense / OPNsense** — API for firewall rules, traffic shaping, per-host stats.
- **OpenWrt** — SSH/ubus for iptables/nftables blocking, SQM QoS, live bandwidth.
- **Pi-hole / AdGuard Home** — DNS query logs per device, domain blocking, ad/tracker
  stats folded into the dashboard.

### Tier C — parental / household features (built on A or B)
- Per-device schedules ("kids' tablets off after 9pm").
- One-click "pause internet" for a device or group.
- Bandwidth quotas and alerts.

---

## Suggested next step

Phase 2's **new-device push notifications** + **port-scan fingerprinting** give the
biggest jump in usefulness with zero new hardware. If you later add a **UniFi**,
**OpenWrt router**, or **Pi-hole**, Phase 3 Tier B unlocks genuine per-device
bandwidth graphs and one-click blocking.
