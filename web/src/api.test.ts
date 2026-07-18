import { test, expect } from "vitest";
import { displayName } from "./api.js";
import { makeDevice } from "./testDevice.js";

test("displayName prefers a user-assigned label", () => {
  const d = makeDevice({ label: "Chad's Phone", hostname: "iphone", ip: "192.168.1.5" });
  expect(displayName(d)).toBe("Chad's Phone");
});

test("displayName falls back to the resolved hostname", () => {
  expect(displayName(makeDevice({ hostname: "Office-TV", ip: "192.168.1.7" }))).toBe("Office-TV");
});

test("displayName uses vendor + last octet when otherwise unnamed", () => {
  expect(displayName(makeDevice({ vendor: "Apple", ip: "192.168.1.42" }))).toBe("Apple · .42");
});

test("displayName hides a private/randomized vendor as Unknown", () => {
  const d = makeDevice({ vendor: "Private (randomized MAC)", ip: "192.168.1.9" });
  expect(displayName(d)).toBe("Unknown · .9");
});
