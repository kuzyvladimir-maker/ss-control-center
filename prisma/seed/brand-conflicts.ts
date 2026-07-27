/**
 * Permanent blocklist of brand/keyword pairs Amazon has already flagged
 * against Salutem-owned listings. Seeded from the 2026-05-17 incident:
 * Retailer Distributor was suspended after 5 ASINs were blocked for
 * Trademark Logo Misuse — Salutem Vita listings whose titles referenced
 * other brands' product names (Goya, El Monterey, Ore-Ida, Oh Snap!,
 * Kraft/Spongebob).
 *
 * The risk-scorer (src/lib/bundle-factory/audit/risk-scorer.ts) reads
 * this table during every scan; any active row that matches an ASIN
 * being audited adds a heavy penalty (+80) and flips the listing to
 * BLOCKED.
 *
 * Future incidents — append to PERMANENT_BLOCKLIST. The seeder is
 * idempotent: it upserts by ASIN+foreign_brand, so re-running won't
 * create duplicates.
 */

import type { PrismaClient } from "../../src/generated/prisma/client";

const INCIDENT_DATE = new Date("2026-05-17");

interface BlocklistEntry {
  asin: string;
  account: string;
  foreign_brand: string;
  product_keywords: string[];
  incident_type: string;
  amazon_action: string;
  notes: string;
}

export const PERMANENT_BLOCKLIST: BlocklistEntry[] = [
  {
    asin: "B0FRG1Y6SN",
    account: "RETAILER",
    foreign_brand: "Goya",
    product_keywords: [
      "plantains",
      "baked plantains",
      "sweet plantains",
      "ripe plantains",
    ],
    incident_type: "trademark_logo_misuse",
    amazon_action: "asin_block",
    notes:
      'Original title: "Salutem Vita – Baked Ripe Plantains, Sweet and ' +
      'Ready-to-Eat, Gift Set, 11 oz – Pack of 5". Brand violation: Goya.',
  },
  {
    asin: "B0FLWN3KZ9",
    account: "RETAILER",
    foreign_brand: "El Monterey",
    product_keywords: ["burritos", "frozen burritos", "mexican burritos"],
    incident_type: "trademark_logo_misuse",
    amazon_action: "asin_block",
    notes:
      'Original title: "Salutem Vita – Burritos Variety Pack, Classic ' +
      'Mexican Flavors in Every Bite, 32 oz, 8 count (Frozen), Gift Set – ' +
      'Pack of 3".',
  },
  {
    asin: "B0FNKR2P3Y",
    account: "RETAILER",
    foreign_brand: "Ore-Ida",
    product_keywords: ["tater tots", "crispy tater tots", "shredded potatoes"],
    incident_type: "trademark_logo_misuse",
    amazon_action: "asin_block",
    notes:
      'Original title: "Salutem Vita – Gluten-Free Extra Crispy Tater Tots, ' +
      'Seasoned Shredded Potatoes, Gift Set, 28 oz – Pack of 6".',
  },
  {
    asin: "B0FJQK4S45",
    account: "RETAILER",
    foreign_brand: "Oh Snap!",
    product_keywords: [
      "dill pickle",
      "pickle cuts",
      "pickle bites",
      "snacking pickles",
    ],
    incident_type: "trademark_logo_misuse",
    amazon_action: "asin_block",
    notes:
      'Original title: "Salutem Vita – Dill Pickle Snacking Cuts, Spicy ' +
      'Pickle Bites, Sweet Pickle Bites, 3.25 oz Gift Set – Pack of 3".',
  },
  {
    asin: "B0FBML98G3",
    account: "RETAILER",
    foreign_brand: "Kraft",
    product_keywords: [
      "spongebob mac & cheese",
      "spongebob shapes",
      "microwavable mac & cheese cups",
    ],
    incident_type: "trademark_logo_misuse",
    amazon_action: "asin_block",
    notes:
      'Original title: "Salutem Vita – Spongebob Shapes Mac & Cheese ' +
      'Microwavable Cups, 4ct Gift Set – Pack of 6".',
  },
];

/**
 * Idempotent seeder — keys on (asin, foreign_brand) so re-running this
 * after a future incident is appended to the same list won't duplicate
 * existing rows. We can't use upsert because (asin, foreign_brand) is
 * not a declared unique key on the model — keeping the model loose lets
 * us record multiple foreign brands per ASIN if that ever happens.
 */
export async function seedBrandConflicts(prisma: PrismaClient): Promise<number> {
  let inserted = 0;
  for (const entry of PERMANENT_BLOCKLIST) {
    const existing = await prisma.brandConflict.findFirst({
      where: { asin: entry.asin, foreign_brand: entry.foreign_brand },
    });
    if (existing) continue;
    await prisma.brandConflict.create({
      data: {
        asin: entry.asin,
        account: entry.account,
        foreign_brand: entry.foreign_brand,
        product_keywords: JSON.stringify(entry.product_keywords),
        incident_date: INCIDENT_DATE,
        incident_type: entry.incident_type,
        amazon_action: entry.amazon_action,
        notes: entry.notes,
        status: "active",
      },
    });
    inserted++;
  }
  return inserted;
}

