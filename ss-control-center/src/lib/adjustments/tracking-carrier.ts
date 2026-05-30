/**
 * Carrier inference from tracking number format.
 *
 * Used when Amazon's Orders Report column `carrier` is "Other" or empty
 * but a tracking-number is present — most US tracking numbers have
 * carrier-specific prefixes/lengths that are unique enough to identify
 * the carrier without an external API call.
 *
 * Patterns (US domestic, ordered most → least specific):
 *
 *   UPS:    1Z[A-Z0-9]{16}             1Z999AA10123456784
 *   FedEx:  exactly 12 digits           123456789012
 *           exactly 15 digits           96 xxxxxxxxxxxxx (Ground 96-prefix is most common)
 *           20 / 22 digits              cross-border / Express
 *   USPS:   starts with 9, 20-22 digits 9400 1xxx... / 9405xxxx...
 *           EA/EC/CP + 9 digits + US    EC123456789US
 *   DHL:    10–11 digits                12345678901
 *   OnTrac: D + 14 digits OR Cxxxx      D10012345678901
 *
 * Returns canonical uppercase string ("UPS", "FEDEX", "USPS", ...) or
 * null when no pattern matches.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // UPS — 1Z prefix, total 18 chars (most distinctive, check first)
  { name: "UPS", re: /^1Z[A-Z0-9]{16}$/i },

  // USPS — most start with 9, 20 or 22 digits. Also EA/EC/CP + 9 digits + US.
  { name: "USPS", re: /^9[0-5]\d{20}$/ },        // 94xx, 95xx (Priority + Ground Advantage)
  { name: "USPS", re: /^9[0-5]\d{18}$/ },        // 20-digit variant
  { name: "USPS", re: /^[EC]A\d{9}US$/i },       // Express International
  { name: "USPS", re: /^[EC]C\d{9}US$/i },
  { name: "USPS", re: /^420\d{27,31}$/ },        // SmartMail / DSP routing

  // FedEx — multiple lengths, no leading 9 to avoid USPS overlap
  { name: "FEDEX", re: /^96\d{20}$/ },           // Ground 22-digit (96-prefix)
  { name: "FEDEX", re: /^96\d{18}$/ },           // Ground 20-digit
  { name: "FEDEX", re: /^\d{12}$/ },             // Express 12-digit
  { name: "FEDEX", re: /^\d{15}$/ },             // SmartPost 15-digit (not starting with 9)

  // DHL — 10 or 11 digits, doesn't start with 9 or 96
  { name: "DHL", re: /^[1-8]\d{9,10}$/ },

  // OnTrac
  { name: "ONTRAC", re: /^D\d{14}$/i },
  { name: "ONTRAC", re: /^C\d{14}$/i },

  // LaserShip — LS + digits, or LX + alphanumerics
  { name: "LASERSHIP", re: /^L[SX][A-Z0-9]{8,18}$/i },
];

export function inferCarrierFromTracking(
  trackingNumber: string | null | undefined,
): string | null {
  if (!trackingNumber) return null;
  const t = trackingNumber.trim().replace(/\s+/g, "");
  if (!t) return null;
  for (const p of PATTERNS) {
    if (p.re.test(t)) return p.name;
  }
  return null;
}
