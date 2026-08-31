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
  // zone header remains - the toggle now offers to expand it again
  expect(screen.getByLabelText("Expand Untrusted")).toBeInTheDocument();
});

test("device nodes are reachable and activatable by keyboard", () => {
  // role="img" on the <svg> made this entire subtree presentational to assistive
  // tech, and the nodes were clickable <g> elements with no tabIndex - so the
  // map had zero keyboard access and the only route to a port scan was a mouse.
  const onInspect = vi.fn();
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
        makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" }),
      ]}
      onInspect={onInspect}
    />
  );

  const node = screen.getByRole("button", { name: /Office-TV.*192\.168\.4\.7.*open details/i });
  expect(node).toHaveAttribute("tabindex", "0");

  fireEvent.keyDown(node, { key: "Enter" });
  expect(onInspect).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(node, { key: " " });
  expect(onInspect).toHaveBeenCalledTimes(2);
});

test("zone collapse toggles are focusable and keyboard-operable", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
        makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" }),
      ]}
    />
  );
  const toggle = screen.getByRole("button", { name: /Collapse Trusted/i });
  expect(toggle).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(toggle, { key: "Enter" });
  expect(screen.getByRole("button", { name: /Expand Trusted/i })).toBeInTheDocument();
});

test("offline devices are hidden by default but can be shown", () => {
  // They used to be dropped entirely, so an unplugged camera was simply absent
  // with no way to tell that from "this device never existed".
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
        makeDevice({ id: "cam", hostname: "Nest-Cam", online: 0, ip: "192.168.4.31" }),
      ]}
    />
  );
  expect(screen.queryByText("Nest-Cam")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /show offline/i }));
  expect(screen.getByText("Nest-Cam")).toBeInTheDocument();
  // ...and it must be announced as offline, not silently mixed in with live ones.
  expect(screen.getByRole("button", { name: /Nest-Cam.*offline/i })).toBeInTheDocument();
});

test("wheel zoom actually prevents the page from scrolling", () => {
  // React registers its synthetic onWheel as a PASSIVE listener, so an
  // e.preventDefault() inside it is silently ignored: zooming the map also
  // scrolled the page. The map attaches its own non-passive listener; this
  // pins that the wheel event really is consumed.
  render(
    <NetworkMap
      devices={[makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" })]}
    />
  );
  const svg = screen.getByRole("group", { name: /Network map/ });
  const evt = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
  svg.dispatchEvent(evt);
  expect(evt.defaultPrevented).toBe(true);
});

test("zoom buttons and reset drive the camera transform directly", () => {
  const { container } = render(
    <NetworkMap
      devices={[makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" })]}
    />
  );
  const camera = container.querySelector("svg > g") as SVGGElement;
  expect(camera.style.transform).toContain("scale(1)");

  fireEvent.click(screen.getByLabelText("Zoom in"));
  expect(camera.style.transform).toContain("scale(1.3)");

  fireEvent.click(screen.getByLabelText("Reset view"));
  expect(camera.style.transform).toContain("scale(1)");
});

test("a drag pan does not open the device panel, a plain click still does", () => {
  const onInspect = vi.fn();
  render(
    <NetworkMap
      devices={[makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" })]}
      onInspect={onInspect}
    />
  );
  const svg = screen.getByRole("group", { name: /Network map/ });
  const node = screen.getByText("Office-TV");
  // jsdom has no PointerEvent, and fireEvent's fallback drops clientX/Y, so
  // build the pointer events out of MouseEvent to keep real coordinates.
  const pointer = (type: string, x: number, y: number) =>
    svg.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

  // drag: pointer moves well past the click-slop threshold before release
  pointer("pointerdown", 10, 10);
  pointer("pointermove", 60, 40);
  pointer("pointerup", 60, 40);
  fireEvent.click(node);
  expect(onInspect).not.toHaveBeenCalled();

  // plain click: no movement between down and up
  pointer("pointerdown", 10, 10);
  pointer("pointerup", 10, 10);
  fireEvent.click(node);
  expect(onInspect).toHaveBeenCalledOnce();
});

test("devices can be grouped by what they are instead of trust", () => {
  render(
    <NetworkMap
      devices={[
        makeDevice({ id: "gw", is_gateway: 1, hostname: "eero", online: 1, ip: "192.168.4.1" }),
        makeDevice({ id: "pc", label: "dell xps", vendor: "Intel Corporate", online: 1, ip: "192.168.4.59" }),
        makeDevice({ id: "bulb", label: "bathroom bulb", vendor: "Espressif Inc.", online: 1, ip: "192.168.4.44" }),
      ]}
    />
  );
  expect(screen.getByText("Trusted")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /by trust/i }));
  expect(screen.getByText("Computers & phones")).toBeInTheDocument();
  expect(screen.getByText("Smart home")).toBeInTheDocument();
});
