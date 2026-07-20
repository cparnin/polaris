import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NetworkMap } from "./NetworkMap.js";
import { makeDevice } from "../testDevice.js";

test("renders the gateway and online devices, and hides offline ones", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
        makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" }),
        makeDevice({ id: "ghost", hostname: "Ghost", online: 0, ip: "192.168.4.9" }),
      ]}
    />
  );
  expect(screen.getByText("eero")).toBeInTheDocument();
  expect(screen.getByText("Office-TV")).toBeInTheDocument();
  expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
  expect(screen.getByText(/2 online/)).toBeInTheDocument();
});

test("clicking a node asks to inspect that device", () => {
  const onInspect = vi.fn();
  render(
    <NetworkMap
      devices={[makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" })]}
      onInspect={onInspect}
    />
  );
  fireEvent.click(screen.getByText("Office-TV"));
  expect(onInspect).toHaveBeenCalledOnce();
  expect(onInspect.mock.calls[0][0].id).toBe("tv");
});

test("shows an exposure badge for a device with risky open ports", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({
          id: "nas",
          hostname: "NAS-01",
          online: 1,
          ip: "192.168.4.50",
          last_portscan_at: 1000,
          risk_count: 2,
        }),
      ]}
    />
  );
  // the node <title> spells out the risk, and the badge shows the count "2"
  expect(screen.getByText(/NAS-01.*2 risky ports/)).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
});

test("shows a clean badge for a scanned device with no risky ports", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({
          id: "printer",
          hostname: "Printer",
          online: 1,
          ip: "192.168.4.60",
          last_portscan_at: 1000,
          risk_count: 0,
        }),
      ]}
    />
  );
  expect(screen.getByText(/Printer.*no risky ports/)).toBeInTheDocument();
  expect(screen.getByText("✓")).toBeInTheDocument();
});

test("shows an empty state when nothing is online", () => {
  render(<NetworkMap devices={[makeDevice({ online: 0 })]} />);
  expect(screen.getByText(/No devices online yet/)).toBeInTheDocument();
});

test("renders the Internet/ISP tier above the gateway", () => {
  render(<NetworkMap devices={[makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", ip: "192.168.4.1" })]} />);
  expect(screen.getByText("Internet / ISP")).toBeInTheDocument();
  expect(screen.getByText("eero")).toBeInTheDocument();
});

test("clusters devices into Trusted and Untrusted zones", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", ip: "192.168.4.1" }),
        makeDevice({ id: "mac", is_self: 1, hostname: "My-Mac", ip: "192.168.4.2" }),
        makeDevice({ id: "tv", hostname: "Trusted-TV", trusted: 1, ip: "192.168.4.7" }),
        makeDevice({ id: "iot", hostname: "Sketchy-IoT", trusted: 0, ip: "192.168.4.9" }),
      ]}
    />
  );
  // Zone labels ("Trusted"/"Untrusted") also appear in the legend, so identify
  // the zones by their unique collapse-toggle labels instead.
  expect(screen.getByLabelText("Collapse Trusted")).toBeInTheDocument();
  expect(screen.getByLabelText("Collapse Untrusted")).toBeInTheDocument();
  // self + trusted land in Trusted; the untrusted device is on its own.
  expect(screen.getByText("My-Mac")).toBeInTheDocument();
  expect(screen.getByText("Trusted-TV")).toBeInTheDocument();
  expect(screen.getByText("Sketchy-IoT")).toBeInTheDocument();
});

test("collapsing a zone hides its devices", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", ip: "192.168.4.1" }),
        makeDevice({ id: "iot", hostname: "Sketchy-IoT", trusted: 0, ip: "192.168.4.9" }),
      ]}
    />
  );
  expect(screen.getByText("Sketchy-IoT")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Collapse Untrusted"));
  expect(screen.queryByText("Sketchy-IoT")).not.toBeInTheDocument();
  // zone header remains — the toggle now offers to expand it again
  expect(screen.getByLabelText("Expand Untrusted")).toBeInTheDocument();
});
