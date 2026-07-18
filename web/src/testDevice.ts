import type { Device } from "./api.js";

/** Build a Device for tests, overriding only the fields a case cares about. */
export function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: "dev-1",
    mac: null,
    ip: null,
    hostname: null,
    vendor: null,
    os_guess: null,
    label: null,
    trusted: 0,
    is_gateway: 0,
    is_self: 0,
    randomized: 0,
    online: 1,
    first_seen: 0,
    last_seen: 0,
    ...overrides,
  };
}
