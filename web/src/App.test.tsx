import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import App from "./App.js";
import { makeDevice } from "./testDevice.js";
import type { Device } from "./api.js";

/**
 * App-level wiring tests with the network faked out: fetch answers from a
 * mutable fixture, and EventSource is a stub whose events the tests fire by
 * hand. That is exactly the layer where the "stale after reconnect" bug lived.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  close() {}
  emit(type: string, data: unknown) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

const fixture: {
  devices: Device[];
  ntfy: { configured: boolean; host: string | null; lastSendOk: boolean | null; lastSendError: string | null; lastSendAt: number | null };
} = { devices: [], ntfy: { configured: true, host: "ntfy.sh", lastSendOk: null, lastSendError: null, lastSendAt: null } };

const fetchMock = vi.fn(async (url: unknown) => {
  const path = String(url);
  const body = path.startsWith("/api/devices")
    ? { devices: fixture.devices, lastScan: null, scanning: false, paused: false }
    : path.startsWith("/api/events")
      ? { events: [] }
      : path.startsWith("/api/health")
        ? { ok: true, paused: false, ntfy: fixture.ntfy, ispName: "ISP", guestModeMsLeft: 0, home: null }
        : { ok: true };
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
});

beforeEach(() => {
  FakeEventSource.instances.length = 0;
  fixture.devices = [];
  fixture.ntfy = { configured: true, host: "ntfy.sh", lastSendOk: null, lastSendError: null, lastSendAt: null };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
});

test("the SSE hello event re-syncs state after a reconnect", async () => {
  render(<App />);
  await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
  const calls = fetchMock.mock.calls.length;

  // Server restarted and the stream reconnected: hello must trigger a re-read
  // of the world, not leave pre-restart data on screen posing as live.
  act(() => {
    FakeEventSource.instances[0].emit("hello", { scanning: false, paused: true, lastScan: null });
  });

  await screen.findByText("▶ Resume"); // paused state came from hello
  await waitFor(() =>
    expect(fetchMock.mock.calls.slice(calls).some(([u]) => String(u).startsWith("/api/devices"))).toBe(true)
  );
});

test("the Risky filter shows only devices with risky ports", async () => {
  fixture.devices = [
    makeDevice({ id: "nas", hostname: "NAS", online: 1, ip: "192.168.4.50", risk_count: 2, last_portscan_at: 1 }),
    makeDevice({ id: "tv", hostname: "SafeTV", online: 1, ip: "192.168.4.7", risk_count: 0, last_portscan_at: 1 }),
  ];
  render(<App />);
  // names show in both the map and the card list; the trust button exists
  // only on cards, which is the list the filter controls
  await screen.findByRole("button", { name: "Mark SafeTV as trusted" });

  fireEvent.click(screen.getByRole("button", { name: "Risky" }));
  expect(screen.getByRole("button", { name: "Mark NAS as trusted" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Mark SafeTV as trusted" })).not.toBeInTheDocument();
});

test("the alerts pill says failing when the last push bounced", async () => {
  fixture.ntfy = { configured: true, host: "ntfy.sh", lastSendOk: false, lastSendError: "404 Not Found", lastSendAt: 1 };
  render(<App />);
  const pill = await screen.findByText("alerts failing");
  expect(pill.closest("button")?.title).toMatch(/404 Not Found/);
});
