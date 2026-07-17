import express from "express";
import cors from "cors";
import { listDevices, recentEvents, setLabel, setTrusted, getDeviceById } from "./db.js";
import { portScan } from "./net/portscan.js";
import {
  runScan,
  startAutoScan,
  isScanning,
  getLastSummary,
  scanBus,
  type ScanSummary,
} from "./scanner.js";
import { ntfyStatus, isNtfyConfigured, sendNtfy } from "./notify.js";

const PORT = Number(process.env.PORT ?? 4000);
// Bind to loopback by default: the API exposes your full device inventory, so
// it must NOT be reachable from the LAN. Override HOST only if you know why.
const HOST = process.env.HOST ?? "127.0.0.1";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 60_000);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    scanning: isScanning(),
    lastScan: getLastSummary(),
    ntfy: ntfyStatus(),
  });
});

app.post("/api/notify/test", async (_req, res) => {
  if (!isNtfyConfigured()) {
    res.status(400).json({ error: "ntfy is not configured (set NTFY_URL)" });
    return;
  }
  const ok = await sendNtfy({
    title: "Iris test notification 🛰️",
    message: "If you can read this, Iris can reach your ntfy topic.",
    tags: ["eye", "white_check_mark"],
  });
  res.status(ok ? 200 : 502).json({ ok });
});

app.get("/api/devices", (_req, res) => {
  res.json({ devices: listDevices(), lastScan: getLastSummary(), scanning: isScanning() });
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
  send("hello", { scanning: isScanning(), lastScan: getLastSummary() });

  const onStart = (d: unknown) => send("scan:start", d);
  const onDone = (d: ScanSummary) => send("scan:done", d);
  const onError = (e: Error) => send("scan:error", { message: e.message });
  scanBus.on("scan:start", onStart);
  scanBus.on("scan:done", onDone);
  scanBus.on("scan:error", onError);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    scanBus.off("scan:start", onStart);
    scanBus.off("scan:done", onDone);
    scanBus.off("scan:error", onError);
  });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Iris server → http://${HOST}:${PORT}`);
  console.log(`  Auto-scanning every ${Math.round(SCAN_INTERVAL_MS / 1000)}s`);
  console.log(`  ntfy notifications: ${isNtfyConfigured() ? "on" : "off (set NTFY_URL)"}\n`);
  startAutoScan(SCAN_INTERVAL_MS);
});
