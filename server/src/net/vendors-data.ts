/**
 * Curated OUI (MAC prefix → vendor) map covering common consumer/home gear.
 * Keys are the first 3 octets, uppercase, no separators (e.g. "F0189F").
 * This is intentionally a small, offline subset. To expand coverage, drop in
 * the full IEEE OUI list or enable the online fallback (see vendors.ts).
 */
export const OUI: Record<string, string> = {
  // Apple
  "F0189F": "Apple", "A45E60": "Apple", "D0817A": "Apple", "3C0754": "Apple",
  "F0DBF8": "Apple", "AC87A3": "Apple", "8866A5": "Apple", "F82793": "Apple",
  "DC2B2A": "Apple", "A85C2C": "Apple", "F4F15A": "Apple", "9CFC01": "Apple",
  // Amazon (Echo, Fire, Ring, eero)
  "FC65DE": "Amazon", "44650D": "Amazon", "F0272D": "Amazon", "68F728": "Amazon",
  "34D270": "Amazon", "747548": "Amazon", "B47C9C": "Amazon", "50DCE7": "Amazon",
  // Google / Nest
  "F4F5D8": "Google", "F4F5E8": "Google", "3C5AB4": "Google", "6466B3": "Google",
  "1CF29A": "Google", "D8EB46": "Google", "20DFB9": "Google",
  // Samsung
  "5CE8EB": "Samsung", "8425DB": "Samsung", "F008D1": "Samsung", "B8C68E": "Samsung",
  "34BE00": "Samsung", "E8508B": "Samsung", "C0BDD1": "Samsung",
  // Raspberry Pi
  "B827EB": "Raspberry Pi", "DCA632": "Raspberry Pi", "E45F01": "Raspberry Pi",
  "2CCF67": "Raspberry Pi", "D83ADD": "Raspberry Pi",
  // Espressif (ESP8266/ESP32 - lots of smart-home DIY)
  "5CCF7F": "Espressif", "A020A6": "Espressif", "240AC4": "Espressif",
  "3C7161": "Espressif", "84F3EB": "Espressif", "7CDFA1": "Espressif",
  // TP-Link
  "50C7BF": "TP-Link", "A42BB0": "TP-Link", "0C8063": "TP-Link", "AC84C6": "TP-Link",
  // Ubiquiti
  "FCECDA": "Ubiquiti", "788A20": "Ubiquiti", "245A4C": "Ubiquiti", "687251": "Ubiquiti",
  "F09FC2": "Ubiquiti", "B4FBE4": "Ubiquiti", "E063DA": "Ubiquiti",
  // Netgear
  "A040A0": "Netgear", "9CD36D": "Netgear", "3894ED": "Netgear",
  // Intel (laptops / NUCs)
  "3C9863": "Intel", "94C691": "Intel", "8C554A": "Intel", "A0C589": "Intel",
  // Sonos
  "5CAAFD": "Sonos", "347E5C": "Sonos", "B8E937": "Sonos",
  // Roku
  "CC6DA0": "Roku", "DC3A5E": "Roku", "B0A737": "Roku",
  // Philips Hue
  "001788": "Philips Hue", "ECB5FA": "Philips Hue",
  // Sonos/Nvidia Shield etc.
  "048D38": "Nvidia", "00044B": "Nvidia",
  // Microsoft (Xbox / Surface)
  "C83F26": "Microsoft", "7C1E52": "Microsoft", "3C8375": "Microsoft",
  // Sony (PlayStation)
  "F8461C": "Sony", "A8E3EE": "Sony", "00041F": "Sony",
  // Wyze / smart cams
  "2CAA8E": "Wyze", "7CA7B0": "Wyze",
};
