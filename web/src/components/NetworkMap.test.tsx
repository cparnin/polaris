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

test("clicking a node reports the selected device", () => {
  const onSelect = vi.fn();
  render(
    <NetworkMap
      devices={[makeDevice({ id: "tv", hostname: "Office-TV", online: 1, trusted: 1, ip: "192.168.4.7" })]}
      onSelect={onSelect}
    />
  );
  fireEvent.click(screen.getByText("Office-TV"));
  expect(onSelect).toHaveBeenCalledOnce();
  expect(onSelect.mock.calls[0][0].id).toBe("tv");
});

test("shows an empty state when nothing is online", () => {
  render(<NetworkMap devices={[makeDevice({ online: 0 })]} />);
  expect(screen.getByText(/No devices online yet/)).toBeInTheDocument();
});
