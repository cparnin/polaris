import express from "express";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost } from "./security.js";
import {
  listDevices,
  recentEvents,
  setLabel,
  setTrusted,
  getDeviceById,
  savePortScan,
  forgetDevice,
} from "./db.js";
import { portScan } from "./net/portscan.js";
import {
  runScan,
  startAutoScan,
  isScanning,
  isPaused,
  setPaused,
  getLastSummary,
  scanBus,
  type ScanSummary,
} from "./scanner.js";
import { ntfyStatus, isNtfyConfigured, sendNtfy } from "./notify.js";

const PORT = Number(process.env.PORT ?? 4000);
// Bind to loopback by default: the API exposes your full device inventory, so
// it must NOT be reachable from the LAN. Override HOST only if you know why.
const HOST = process.env.HOST ?? "127.0.0.1";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 300_000);

const app = express();

// Defense-in-depth for a loopback service that exposes your whole network map.
// The dashboard talks to us same-origin (Vite dev proxy / served build), so we
// need no CORS at all — and we reject any request whose Host header isn't a
// loopback name to block DNS-rebinding attacks. See ./security.ts.
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

app.use((req, res, next) => {
  if (isLoopbackHost(req.headers.host ?? "", EXTRA_HOSTS)) {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden: request Host is not a loopback address" });
});

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    scanning: isScanning(),
    paused: isPaused(),
    lastScan: getLastSummary(),
    ntfy: ntfyStatus(),
  });
});

// Pause / resume the auto-scan loop. Pausing stops all scanning (and its CPU +
// network use) while leaving the dashboard live; resuming kicks off a scan now.
app.post("/api/pause", (_req, res) => {
  setPaused(true);
  res.json({ ok: true, paused: true });
});
app.post("/api/resume", (_req, res) => {
  setPaused(false);
  if (!isScanning()) void runScan().catch((e) => console.error("[scan] resume scan failed:", e.message));
  res.json({ ok: true, paused: false });
});

// Full off switch: stop Polaris entirely. If we're running as the macOS
// LaunchAgent, boot the whole job out so KeepAlive doesn't respawn it (it will
// come back at next login); otherwise just exit the process. Runs detached so
// it completes even as this process is torn down.
app.post("/api/quit", (_req, res) => {
  res.json({ ok: true, stopping: true });
  setTimeout(() => {
    const uid = process.getuid?.() ?? 0;
    const label = process.env.POLARIS_LAUNCHD_LABEL ?? "com.polaris.dashboard";
    try {
      const child = spawn("launchctl", ["bootout", `gui/${uid}/${label}`], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => process.exit(0));
    } catch {
      process.exit(0);
    }
    // Fallback if bootout didn't apply (e.g. not launched by launchd).
    setTimeout(() => process.exit(0), 1500);
  }, 200);
});

app.post("/api/notify/test", async (_req, res) => {
  if (!isNtfyConfigured()) {
    res.status(400).json({ error: "ntfy is not configured (set NTFY_URL)" });
    return;
  }
  const ok = await sendNtfy({
    title: "Polaris test notification 🛰️",
    message: "If you can read this, Polaris can reach your ntfy topic.",
    tags: ["eye", "white_check_mark"],
  });
  res.status(ok ? 200 : 502).json({ ok });
});

app.get("/api/devices", (_req, res) => {
  res.json({
    devices: listDevices(),
    lastScan: getLastSummary(),
    scanning: isScanning(),
    paused: isPaused(),
  });
});

app.get("/api/events", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  res.json({ events: recentEvents(limit) });
});

app.post("/api/scan", async (_req, res) => {
  if (isScanning()) {
    res.status(409).json({ error: "A scan is already in progress" });
    return;
  }
  try {
    const summary = await runScan();
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/devices/:id", (req, res) => {
  const { id } = req.params;
  const { label, trusted } = req.body ?? {};
  if (label !== undefined) setLabel(id, label === "" ? null : label);
  if (trusted !== undefined) setTrusted(id, Boolean(trusted));
  res.json({ ok: true });
});

// Forget a device and its history (e.g. dead records from an old subnet).
// If it's still on the network it reappears on the next scan as a new device.
app.delete("/api/devices/:id", (req, res) => {
  const removed = forgetDevice(req.params.id);
  if (!removed) {
    res.status(404).json({ error: "Unknown device" });
    return;
  }
  res.json({ ok: true });
});

// Opt-in port / service scan of a single device (nmap -sV). On-demand only.
app.post("/api/devices/:id/portscan", async (req, res) => {
  const dev = getDeviceById(req.params.id);
  if (!dev) {
    res.status(404).json({ error: "Unknown device" });
    return;
  }
  if (!dev.ip) {
    res.status(400).json({ error: "Device has no IP to scan" });
    return;
  }
  try {
    const result = await portScan(dev.ip);
    // Persist so the map can badge this device by exposure without re-scanning.
    // Only record results where nmap actually completed (clean scans included).
    if (result.scanned) {
      savePortScan(dev.id, result.ports, result.risks.length, result.scannedAt);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Server-Sent Events: push scan lifecycle to the dashboard in real time.
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send("hello", { scanning: isScanning(), paused: isPaused(), lastScan: getLastSummary() });

  const onStart = (d: unknown) => send("scan:start", d);
  const onDone = (d: ScanSummary) => send("scan:done", d);
  const onError = (e: Error) => send("scan:error", { message: e.message });
  const onPaused = (d: unknown) => send("scan:paused", d);
  scanBus.on("scan:start", onStart);
  scanBus.on("scan:done", onDone);
  scanBus.on("scan:error", onError);
  scanBus.on("scan:paused", onPaused);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    scanBus.off("scan:start", onStart);
    scanBus.off("scan:done", onDone);
    scanBus.off("scan:error", onError);
    scanBus.off("scan:paused", onPaused);
  });
});

// In production we serve the compiled dashboard from the same origin as the API
// (so there's no Vite dev server, no bundler, and no CORS surface). In dev this
// folder doesn't exist and Vite serves the UI on :5173 with a proxy instead.
const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(here, "..", "..", "web", "dist");
const servingUI = existsSync(join(WEB_DIST, "index.html"));
if (servingUI) {
  app.use(express.static(WEB_DIST));
  // SPA fallback: any non-/api route returns index.html so client routing works.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(WEB_DIST, "index.html")));
}

app.listen(PORT, HOST, () => {
  console.log(`\n  Polaris server → http://${HOST}:${PORT}`);
  console.log(`  Dashboard: ${servingUI ? `http://${HOST}:${PORT}` : "run `npm run dev` (Vite on :5173)"}`);
  console.log(`  Auto-scanning every ${Math.round(SCAN_INTERVAL_MS / 1000)}s`);
  console.log(`  ntfy notifications: ${isNtfyConfigured() ? "on" : "off (set NTFY_URL)"}\n`);
  startAutoScan(SCAN_INTERVAL_MS);
});
