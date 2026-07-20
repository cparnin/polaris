import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceDetailPanel } from "./DeviceDetailPanel.js";
import { makeDevice } from "../testDevice.js";
import { api } from "../api.js";

beforeEach(() => vi.restoreAllMocks());

test("renders identity and the persisted open ports", () => {
  const d = makeDevice({
    id: "nas",
    hostname: "NAS-01",
    ip: "192.168.4.50",
    vendor: "Synology",
    last_portscan_at: 1000,
    risk_count: 1,
    open_ports: JSON.stringify([
      { port: 445, proto: "tcp", service: "microsoft-ds", product: null, risk: "SMB exposed" },
      { port: 22, proto: "tcp", service: "ssh", product: "OpenSSH", risk: null },
    ]),
  });
  render(<DeviceDetailPanel device={d} onClose={() => {}} onScanned={() => {}} />);

  expect(screen.getByText("NAS-01")).toBeInTheDocument();
  expect(screen.getByText("Synology")).toBeInTheDocument();
  expect(screen.getByText("445")).toBeInTheDocument();
  expect(screen.getByText("ssh")).toBeInTheDocument();
  expect(screen.getByText(/1 risky exposure/)).toBeInTheDocument();
});

test("running a scan calls the API and reports back", async () => {
  vi.spyOn(api, "portScan").mockResolvedValue({
    available: true,
    scanned: true,
    ip: "192.168.4.7",
    scannedAt: 1,
    durationMs: 5000,
    ports: [{ port: 8009, proto: "tcp", service: "https", product: "Google Cast", risk: null }],
    risks: [],
    message: null,
  });
  const onScanned = vi.fn();
  const d = makeDevice({ id: "tv", hostname: "Office-TV", ip: "192.168.4.7" });

  render(<DeviceDetailPanel device={d} onClose={() => {}} onScanned={onScanned} />);
  fireEvent.click(screen.getByText(/scan ports/i));

  await waitFor(() => expect(screen.getByText("8009")).toBeInTheDocument());
  expect(api.portScan).toHaveBeenCalledWith("tv");
  expect(onScanned).toHaveBeenCalled();
});

test("closes when the backdrop is clicked", () => {
  const onClose = vi.fn();
  const d = makeDevice({ id: "x", hostname: "Thing", ip: "192.168.4.9" });
  render(<DeviceDetailPanel device={d} onClose={onClose} onScanned={() => {}} />);
  fireEvent.click(screen.getByLabelText("Close"));
  expect(onClose).toHaveBeenCalledOnce();
});
