import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopologyView } from "./TopologyView.js";
import { makeDevice } from "../testDevice.js";
import type { Device } from "../api.js";

function renderTopo(
  devices: Device[],
  over: Partial<React.ComponentProps<typeof TopologyView>> = {}
) {
  return render(
    <TopologyView
      devices={devices}
      visible={devices}
      newIds={new Set()}
      queryActive={false}
      onInspect={vi.fn()}
      {...over}
    />
  );
}

test("renders the gateway and online devices, and hides offline ones", () => {
  renderTopo([
    makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
    makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" }),
    makeDevice({ id: "ghost", hostname: "Ghost", online: 0, ip: "192.168.4.9" }),
  ]);
  expect(screen.getByText("eero")).toBeInTheDocument();
  expect(screen.getByText("Office-TV")).toBeInTheDocument();
  expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
  expect(screen.getByText(/2 online/)).toBeInTheDocument();
});

test("clicking a tile asks to inspect that device", () => {
  const onInspect = vi.fn();
  renderTopo(
    [makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" })],
    { onInspect }
  );
  fireEvent.click(screen.getByRole("button", { name: /Office-TV.*open details/ }));
  expect(onInspect).toHaveBeenCalledOnce();
  expect(onInspect.mock.calls[0][0].id).toBe("tv");
});

test("shows an exposure badge for a device with risky open ports", () => {
  renderTopo([
    makeDevice({
      id: "nas",
      hostname: "NAS-01",
      online: 1,
      ip: "192.168.4.50",
      last_portscan_at: Date.now() - 1000,
      risk_count: 2,
    }),
  ]);
  expect(screen.getByTitle(/NAS-01.*2 risky ports/)).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
});

test("shows a clean badge for a recently scanned device with no risky ports", () => {
  renderTopo([
    makeDevice({
      id: "printer",
      hostname: "Printer",
      online: 1,
      ip: "192.168.4.60",
      last_portscan_at: Date.now() - 1000,
      risk_count: 0,
    }),
  ]);
  expect(screen.getByTitle(/Printer.*no risky ports/)).toBeInTheDocument();
  expect(screen.getByText("✓")).toBeInTheDocument();
});

test("an old clean scan shows as stale, not a confident green check", () => {
  renderTopo([
    makeDevice({
      id: "cam",
      hostname: "Old-Cam",
      online: 1,
      ip: "192.168.4.70",
      last_portscan_at: Date.now() - 90 * 24 * 60 * 60 * 1000,
      risk_count: 0,
    }),
  ]);
  expect(screen.getByTitle(/Old-Cam.*stale, rescan to confirm/)).toBeInTheDocument();
});

test("shows the first-scan empty state with no devices at all", () => {
  renderTopo([]);
  expect(screen.getByText(/First scan running/)).toBeInTheDocument();
});

test("renders the Internet/ISP tier above the gateway", () => {
  renderTopo([makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", ip: "192.168.4.1" })], {
    ispName: "Frontier",
  });
  expect(screen.getByText("Frontier")).toBeInTheDocument();
  expect(screen.getByText("eero")).toBeInTheDocument();
});

test("clusters devices into Trusted and Untrusted zones", () => {
  renderTopo([
    makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", ip: "192.168.4.1" }),
    makeDevice({ id: "mac", is_self: 1, hostname: "My-Mac", ip: "192.168.4.2" }),
    makeDevice({ id: "tv", hostname: "Trusted-TV", trusted: 1, ip: "192.168.4.7" }),
    makeDevice({ id: "iot", hostname: "Sketchy-IoT", trusted: 0, ip: "192.168.4.9" }),
  ]);
  expect(screen.getByLabelText("Collapse Trusted")).toBeInTheDocument();
  expect(screen.getByLabelText("Collapse Untrusted")).toBeInTheDocument();
  expect(screen.getByText("My-Mac")).toBeInTheDocument();
  expect(screen.getByText("Trusted-TV")).toBeInTheDocument();
  expect(screen.getByText("Sketchy-IoT")).toBeInTheDocument();
});

test("collapsing a zone hides its tiles", () => {
  renderTopo([
    makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", ip: "192.168.4.1" }),
    makeDevice({ id: "iot", hostname: "Sketchy-IoT", trusted: 0, ip: "192.168.4.9" }),
  ]);
  expect(screen.getByText("Sketchy-IoT")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Collapse Untrusted"));
  expect(screen.queryByText("Sketchy-IoT")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Expand Untrusted")).toBeInTheDocument();
});

test("offline devices are hidden by default but can be shown, announced as offline", () => {
  renderTopo([
    makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
    makeDevice({ id: "cam", hostname: "Nest-Cam", online: 0, ip: "192.168.4.31" }),
  ]);
  expect(screen.queryByText("Nest-Cam")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /show offline/i }));
  expect(screen.getByRole("button", { name: /Nest-Cam.*offline/i })).toBeInTheDocument();
});

test("a live search reveals matching offline devices without the toggle", () => {
  // Searching for an unplugged camera has to find it; "hidden because
  // offline" and "does not exist" must not look the same under a search.
  renderTopo(
    [
      makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
      makeDevice({ id: "cam", hostname: "Nest-Cam", online: 0, ip: "192.168.4.31" }),
    ],
    { queryActive: true }
  );
  expect(screen.getByText("Nest-Cam")).toBeInTheDocument();
});

test("devices can be grouped by what they are instead of trust", () => {
  renderTopo([
    makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
    makeDevice({ id: "pc", label: "dell xps", vendor: "Intel Corporate", online: 1, ip: "192.168.4.59" }),
    makeDevice({ id: "bulb", label: "bathroom bulb", vendor: "Espressif Inc.", online: 1, ip: "192.168.4.44" }),
  ]);
  expect(screen.getByText("Trusted")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /by trust/i }));
  expect(screen.getByText("Computers & phones")).toBeInTheDocument();
  expect(screen.getByText("Smart home")).toBeInTheDocument();
});
