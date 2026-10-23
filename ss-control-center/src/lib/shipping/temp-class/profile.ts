// The rate-selection profile switch.
//
// One Setting row (`shipping_rate_profile`) decides how the temperature-aware
// engine behaves, so the owner can flip it with a single word — no deploy:
//
//   "summer"  — the engine is OFF. Pure Master Prompt v3.5 behaviour, the
//               one-switch rollback (git tag shipping-frozen-summer-profile-
//               2026-10-23 is the matching code snapshot).
//   "shadow"  — the engine COMPUTES the temperature-aware pick and the saving
//               and shows them on the card, but purchases still go by summer.
//               This is the launch state (owner: "в тени первую неделю").
//   "live"    — battle mode: purchases use the temperature-aware pick.
//
// Default (no row) = "shadow": once deployed the card starts showing what the
// new logic would do without changing a single purchase. Set it to "summer" to
// fully disable; "live" to enable buying.

export type RateProfile = "summer" | "shadow" | "live";

export const RATE_PROFILE_SETTING_KEY = "shipping_rate_profile";
export const DEFAULT_RATE_PROFILE: RateProfile = "shadow";

export function parseRateProfile(v: string | null | undefined): RateProfile {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "summer" || s === "shadow" || s === "live") return s;
  return DEFAULT_RATE_PROFILE;
}

interface PrismaLike {
  setting: {
    findUnique: (args: {
      where: { key: string };
    }) => Promise<{ value: string } | null>;
  };
}

// 60-second cache so a dashboard pass over many orders reads the flag once.
let cache: { at: number; value: RateProfile } | null = null;
const TTL_MS = 60_000;

export async function getRateProfile(prisma: PrismaLike): Promise<RateProfile> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const row = await prisma.setting.findUnique({
      where: { key: RATE_PROFILE_SETTING_KEY },
    });
    const value = parseRateProfile(row?.value);
    cache = { at: Date.now(), value };
    return value;
  } catch {
    // DB hiccup → safest is the pure-summer rollback, but don't cache a
    // transient failure.
    return "summer";
  }
}

/** Clear the memoised profile (tests / after a settings write). */
export function __clearRateProfileCache(): void {
  cache = null;
}
