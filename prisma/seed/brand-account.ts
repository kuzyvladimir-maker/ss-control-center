/**
 * Pre-seed for `BrandAccount` — mapping of brand × marketplace channel ×
 * account role (brand owner vs authorized seller).
 *
 * - Salutem Vita: brand-owned on Amazon Salutem + Walmart, authorized on
 *   the other 3 Amazon accounts (Personal, AMZ Commerce, Retailer).
 * - Starfit: brand-owned on Amazon Sirius, authorized on Salutem/Personal/AMZ.
 */

import type { Prisma } from "../../src/generated/prisma/client";

export const BRAND_ACCOUNT_SEED: Prisma.BrandAccountCreateInput[] = [
  // Salutem Vita
  {
    brand: "Salutem Vita",
    channel: "AMAZON_SALUTEM",
    is_brand_owner: true,
    is_authorized_seller: false,
  },
  {
    brand: "Salutem Vita",
    channel: "AMAZON_PERSONAL",
    is_brand_owner: false,
    is_authorized_seller: true,
  },
  {
    brand: "Salutem Vita",
    channel: "AMAZON_AMZCOM",
    is_brand_owner: false,
    is_authorized_seller: true,
  },
  {
    brand: "Salutem Vita",
    channel: "AMAZON_RETAILER",
    is_brand_owner: false,
    is_authorized_seller: true,
  },
  {
    brand: "Salutem Vita",
    channel: "WALMART",
    is_brand_owner: true,
    is_authorized_seller: false,
  },

  // Starfit (brand-owned by Sirius International)
  {
    brand: "Starfit",
    channel: "AMAZON_SIRIUS",
    is_brand_owner: true,
    is_authorized_seller: false,
  },
  {
    brand: "Starfit",
    channel: "AMAZON_SALUTEM",
    is_brand_owner: false,
    is_authorized_seller: true,
  },
  {
    brand: "Starfit",
    channel: "AMAZON_PERSONAL",
    is_brand_owner: false,
    is_authorized_seller: true,
  },
  {
    brand: "Starfit",
    channel: "AMAZON_AMZCOM",
    is_brand_owner: false,
    is_authorized_seller: true,
  },
];

/** Idempotent seeder — upserts on the (brand, channel) composite key. */
export async function seedBrandAccounts(
  prisma: import("../../src/generated/prisma/client").PrismaClient
): Promise<number> {
  let count = 0;
  for (const ba of BRAND_ACCOUNT_SEED) {
    await prisma.brandAccount.upsert({
      where: { brand_channel: { brand: ba.brand, channel: ba.channel } },
      create: ba,
      update: ba,
    });
    count++;
  }
  return count;
}
