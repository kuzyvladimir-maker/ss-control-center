/**
 * Pre-seed for `GTINExemption` — one row per
 *   (brand × channel × category)
 * combination, all defaulting to status NOT_REQUESTED. Vladimir flips
 * statuses to PENDING_APPLICATION / UNDER_REVIEW / APPROVED as he files
 * actual applications.
 *
 * Brands × channels seeded:
 *   Salutem Vita: AMAZON_SALUTEM, AMAZON_PERSONAL, AMAZON_AMZCOM,
 *                 AMAZON_RETAILER, WALMART
 *   Starfit:      AMAZON_SIRIUS,  AMAZON_SALUTEM,  AMAZON_PERSONAL,
 *                 AMAZON_AMZCOM
 *
 * Categories (all): FROZEN_GROCERY, REFRIGERATED, SHELF_STABLE, PET_FOOD,
 *                   HEALTH_BEAUTY, BABY, OTHER → 7 cats
 *
 * Total: 9 brand-channel pairs × 7 categories = 63 rows.
 */

const BRAND_CHANNEL_PAIRS: Array<{ brand: string; channel: string }> = [
  // Salutem Vita
  { brand: "Salutem Vita", channel: "AMAZON_SALUTEM" },
  { brand: "Salutem Vita", channel: "AMAZON_PERSONAL" },
  { brand: "Salutem Vita", channel: "AMAZON_AMZCOM" },
  { brand: "Salutem Vita", channel: "AMAZON_RETAILER" },
  { brand: "Salutem Vita", channel: "WALMART" },
  // Starfit
  { brand: "Starfit", channel: "AMAZON_SIRIUS" },
  { brand: "Starfit", channel: "AMAZON_SALUTEM" },
  { brand: "Starfit", channel: "AMAZON_PERSONAL" },
  { brand: "Starfit", channel: "AMAZON_AMZCOM" },
];

const CATEGORIES = [
  "FROZEN_GROCERY",
  "REFRIGERATED",
  "SHELF_STABLE",
  "PET_FOOD",
  "HEALTH_BEAUTY",
  "BABY",
  "OTHER",
] as const;

/** Idempotent seeder — composite key (brand, channel, category). */
export async function seedGtinExemptions(
  prisma: import("../../src/generated/prisma/client").PrismaClient
): Promise<number> {
  let count = 0;
  for (const { brand, channel } of BRAND_CHANNEL_PAIRS) {
    for (const category of CATEGORIES) {
      await prisma.gTINExemption.upsert({
        where: {
          brand_channel_category: { brand, channel, category },
        },
        create: { brand, channel, category, status: "NOT_REQUESTED" },
        update: {},
      });
      count++;
    }
  }
  return count;
}

export const GTIN_EXEMPTION_SEED_COUNT =
  BRAND_CHANNEL_PAIRS.length * CATEGORIES.length;
