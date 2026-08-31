import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatBar } from "./StatBar.js";
import { makeDevice } from "../testDevice.js";

test("counts devices with risky ports as Exposures", () => {
  render(
    <StatBar
      devices={[
        makeDevice({ id: "a", online: 1, risk_count: 2, last_portscan_at: 1 }),
        makeDevice({ id: "b", online: 1, risk_count: 0, last_portscan_at: 1 }),
        makeDevice({ id: "c", online: 0, risk_count: 1, last_portscan_at: 1 }),
      ]}
    />
  );
  const label = screen.getByText("Exposures");
  // two devices have risk_count > 0 (offline ones still count - the exposure
  // was real when found and comes back with the device)
  expect(label.previousSibling?.textContent).toBe("2");
});

test("shows dashes, not confident zeros, before the first scan", () => {
  render(<StatBar devices={[]} loading />);
  expect(screen.getAllByText("-").length).toBe(4);
});
