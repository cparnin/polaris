import { test, expect } from "vitest";
import { deviceIcon } from "./deviceMeta.js";
import { makeDevice } from "./testDevice.js";

test("deviceIcon flags the gateway first", () => {
  expect(deviceIcon(makeDevice({ is_gateway: 1, vendor: "Apple" }))).toBe("🛜");
});

test("deviceIcon infers a category from vendor/hostname", () => {
  expect(deviceIcon(makeDevice({ hostname: "Chads-MacBook-Pro" }))).toBe("🍎");
  expect(deviceIcon(makeDevice({ vendor: "Canon" }))).toBe("🖨️");
  expect(deviceIcon(makeDevice({ vendor: "Sonos" }))).toBe("🔊");
});

test("deviceIcon marks randomized MACs, then unknowns", () => {
  expect(deviceIcon(makeDevice({ randomized: 1 }))).toBe("🕶️");
  expect(deviceIcon(makeDevice({ vendor: "Weird Unknown Co" }))).toBe("❔");
});
