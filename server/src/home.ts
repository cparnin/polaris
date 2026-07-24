import { getMeta, setMeta } from "./db.js";

/**
 * Home-network anchor: remember which gateway(s) count as "home" and stay
 * quiet everywhere else.
 *
 * Polaris runs on a laptop, and a laptop travels. Joining a friend's Wi-Fi
 * used to fire a "new device" push for every TV and phone in their house -
 * technically correct, completely useless. The network you're on is identified
 * by its gateway's MAC address (SSIDs never reach us, and subnets collide:
 * half the world is 192.168.1.0/24). When the current gateway isn't anchored,
 * new devices are still discovered and recorded, but nothing pushes to your
 * phone and nothing gets auto port-scanned - nmap-ing a host you don't own
 * is not a favor.
 *
 * It's a set, not a single value, because one home can present several
 * gateway MACs (a guest SSID, a second access point). Each one costs a single
 * click on the dashboard banner the first time you join it.
 */

const META_KEY = "homeGateways";

export interface HomeStatus {
  /** Anchored gateway MACs (lowercase, colon-separated). */
  gateways: string[];
  /** Gateway of the most recent scan, null before any scan completes. */
  current: { gatewayIp: string | null; gatewayMac: string | null };
  /** True when the current network's gateway is not anchored. */
  away: boolean;
}

let currentGatewayIp: string | null = null;
let currentGatewayMac: string | null = null;
let away = false;

/** Anchored gateway MACs. Tolerates absent or corrupt meta rows. */
export function getHomeGateways(): string[] {
  try {
    const parsed: unknown = JSON.parse(getMeta(META_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is string => typeof m === "string").map((m) => m.toLowerCase());
  } catch {
    return [];
  }
}

function saveHomeGateways(macs: string[]): void {
  setMeta(META_KEY, JSON.stringify([...new Set(macs)]));
}

/**
 * Recompute the away state from a finished scan's gateway. Returns `away`.
 *
 * Bootstrap: with nothing anchored yet (first run ever, or first run after
 * upgrading to a build with this feature), the current gateway is adopted as
 * home. Whatever network you're on at that moment is by definition the one
 * you monitor. Mis-adoptions can be undone from the API.
 *
 * A gateway whose MAC we can't resolve counts as away rather than home: the
 * kernel talks to the home router constantly, so its ARP entry is effectively
 * always present - an unresolvable gateway is itself a sign of a strange
 * network, and the failure mode of muting is quieter than the failure mode
 * of spamming.
 */
export function updateHomeState(gatewayIp: string | null, gatewayMac: string | null): boolean {
  currentGatewayIp = gatewayIp;
  currentGatewayMac = gatewayMac ? gatewayMac.toLowerCase() : null;

  let gateways = getHomeGateways();
  if (gateways.length === 0 && currentGatewayMac) {
    saveHomeGateways([currentGatewayMac]);
    gateways = [currentGatewayMac];
    console.log(`[home] anchored ${currentGatewayMac} (${gatewayIp}) as the home gateway`);
  }

  away = !currentGatewayMac || !gateways.includes(currentGatewayMac);
  return away;
}

/** True when the last scan ran on a network whose gateway is not anchored. */
export function isAway(): boolean {
  return away;
}

export function homeStatus(): HomeStatus {
  return {
    gateways: getHomeGateways(),
    current: { gatewayIp: currentGatewayIp, gatewayMac: currentGatewayMac },
    away,
  };
}

/**
 * Anchor the current network's gateway as home ("this is my home network").
 * Fails when no scan has resolved a gateway MAC yet - there is nothing safe
 * to anchor, and anchoring an unknown would mean anchoring nothing.
 */
export function anchorCurrentGateway(): HomeStatus {
  if (!currentGatewayMac) {
    throw new Error("No gateway MAC known yet - wait for a scan to finish");
  }
  saveHomeGateways([...getHomeGateways(), currentGatewayMac]);
  away = false;
  console.log(`[home] anchored ${currentGatewayMac} (${currentGatewayIp}) as a home gateway`);
  return homeStatus();
}

/** Remove an anchored gateway. Returns false if it wasn't anchored. */
export function removeHomeGateway(mac: string): boolean {
  const target = mac.toLowerCase();
  const gateways = getHomeGateways();
  if (!gateways.includes(target)) return false;
  saveHomeGateways(gateways.filter((m) => m !== target));
  // The network we're on may just have stopped being home.
  away = !currentGatewayMac || !getHomeGateways().includes(currentGatewayMac);
  return true;
}
