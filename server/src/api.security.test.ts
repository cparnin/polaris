import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

/**
 * End-to-end tests for the "who is allowed to talk to me" layer.
 *
 * These are the highest-consequence guarantees Polaris makes - the API serves a
 * complete inventory of your home network, and one route shells out to
 * `launchctl bootout`. Both guards had real holes, and unit tests on the pure
 * functions don't prove the middleware is actually wired into the request path
 * (in the right ORDER, before the body parser, static files and the SPA
 * fallback). So this boots the real server and speaks HTTP to it.
 */

const PORT = 4111;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "polaris-api-"));

let server: ChildProcess;

/**
 * Issue a request with an arbitrary Host header.
 *
 * fetch() cannot do this: `Host` is a forbidden header name in the spec, so
 * undici silently drops it and the request goes out with the real host - which
 * makes a rebinding test quietly pass no matter what the server does. Raw
 * node:http is the only way to actually spoof it.
 */
function getWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume(); // drain so the socket closes
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(here, "index.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      POLARIS_DATA_DIR: dataDir,
      POLARIS_ENV_FILE: join(dataDir, "nonexistent.env"), // ignore the real .env
      AUTOSCAN_NEW_DEVICES: "0",
      NTFY_URL: "",
      ALLOWED_HOSTS: "",
    },
    stdio: "ignore",
  });

  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not come up");
});

after(() => {
  server?.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
});

test("rejects a non-loopback Host header", async () => {
  assert.equal(await getWithHost("/api/devices", "evil.com"), 403);
});

test("rejects a hostname that merely starts with 127. (DNS rebinding)", async () => {
  // The exact bypass that shipped: `host.startsWith("127.")` accepted this, so
  // a page served from 127.0.0.1.evil.com - rebound to loopback - was
  // same-origin with Polaris and could read the whole device inventory.
  for (const host of ["127.0.0.1.evil.com", "127.evil.com", "127.0.0.1.nip.io"]) {
    assert.equal(await getWithHost("/api/devices", host), 403, `${host} must be refused`);
  }
});

test("allows genuine loopback hosts", async () => {
  for (const host of ["127.0.0.1", "localhost", "127.5.5.5"]) {
    assert.equal(await getWithHost("/api/health", host), 200, `${host} must be allowed`);
  }
});

test("the Host guard also covers static files and the SPA fallback", async () => {
  // Registering it after the routes would leave these two paths open.
  for (const path of ["/", "/some/spa/route", "/logo.svg"]) {
    assert.equal(await getWithHost(path, "evil.com"), 403, `${path} must be refused`);
  }
});

test("rejects a cross-site form POST (CSRF)", async () => {
  // No CORS stops a page READING our reply; it does not stop a simple POST
  // being SENT. /api/quit shells out to `launchctl bootout`, so an
  // auto-submitting form on any site could kill the monitor until next login.
  const res = await fetch(`${BASE}/api/pause`, {
    method: "POST",
    headers: {
      Origin: "https://evil.com",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "x=1",
  });
  assert.equal(res.status, 403);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.paused, false, "the refused request must not have taken effect");
});

test("rejects a POST that declares itself cross-site", async () => {
  const res = await fetch(`${BASE}/api/pause`, {
    method: "POST",
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

test("allows the dashboard's own same-origin POSTs", async () => {
  const res = await fetch(`${BASE}/api/pause`, {
    method: "POST",
    headers: { Origin: BASE, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(res.status, 200);
  await fetch(`${BASE}/api/resume`, { method: "POST", headers: { Origin: BASE } });
});

test("a hostile ?limit can neither dump the table nor leak a stack trace", async () => {
  // `?limit=-1` became SQL `LIMIT -1` - unbounded. `?limit=abc` reached SQLite
  // as NaN and threw, and NODE_ENV is unset under launchd, so Express answered
  // with a full stack trace including absolute filesystem paths.
  const neg = await fetch(`${BASE}/api/events?limit=-1`);
  assert.equal(neg.status, 200);
  assert.ok((await neg.json()).events.length <= 1, "negative limit must not be unbounded");

  const junk = await fetch(`${BASE}/api/events?limit=abc`);
  assert.equal(junk.status, 200);
  const body = await junk.text();
  assert.doesNotMatch(body, /at .*\/server\/src/, "no stack trace in the response");

  const huge = await fetch(`${BASE}/api/events?limit=999999`);
  assert.ok((await huge.json()).events.length <= 500, "capped at 500");
});

test("rejects a label that isn't a sane string", async () => {
  const bad = await fetch(`${BASE}/api/devices/aa:bb:cc:dd:ee:ff`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ label: { evil: true } }),
  });
  assert.equal(bad.status, 400);

  const huge = await fetch(`${BASE}/api/devices/aa:bb:cc:dd:ee:ff`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ label: "x".repeat(5000) }),
  });
  assert.equal(huge.status, 400);
});

test("static file serving has no path traversal", async () => {
  for (const path of ["/../../.env", "/assets/../../../.env", "/%2e%2e%2f%2e%2e%2f.env"]) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text();
    assert.doesNotMatch(body, /NTFY_URL|NTFY_TOKEN/, `${path} must not serve the env file`);
  }
});

test("guest mode mutes alerts on a timer and validates its input", async () => {
  // Guests' phones use randomized MACs, so per-device allowlisting can't work -
  // the friend you approved last month arrives as a new device today. A
  // time-boxed mute is the honest mechanism, so it must actually expire.
  const on = await fetch(`${BASE}/api/guest-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ hours: 4 }),
  });
  assert.equal(on.status, 200);
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.ok(health.guestModeMsLeft > 3.9 * 3600_000, "roughly four hours left");

  const off = await fetch(`${BASE}/api/guest-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ hours: 0 }),
  });
  assert.equal(off.status, 200);
  assert.equal((await (await fetch(`${BASE}/api/health`)).json()).guestModeMsLeft, 0);

  // No permanent mute, and nothing that reaches a timer as NaN.
  for (const hours of [-1, 99, "abc", null]) {
    const bad = await fetch(`${BASE}/api/guest-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ hours }),
    });
    assert.equal(bad.status, 400, `hours=${hours} must be refused`);
  }
});
