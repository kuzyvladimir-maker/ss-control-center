/**
 * A+ Content Factory — product concepts.
 *
 * Our catalog isn't one thing. Each listing is classified into a CONCEPT that
 * drives the A+ template: which disclaimer (if any), how images treat branding,
 * and concept-specific generation guidance. Most are OUR OWN brand (Salutem Vita /
 * Generic) with NO third-party IP constraint — only gift baskets that contain
 * third-party products get the logo-free + curator-disclaimer treatment.
 */

export type Concept = "ownfood" | "cooler" | "coldpack" | "supplement" | "giftbasket";

export interface ConceptConfig {
  label: string;
  /** Module-4 purpose (how-to / serve / take). */
  serveLabel: string;
  /** Module-5 heading. */
  whatsInsideLabel: string;
  /** Disclaimer appended to module 5 (and required by the gate). */
  disclaimer: "curator" | "fda" | null;
  /** Branding rule appended to every image brief. */
  imageSuffix: string;
  /** Concept-specific guidance added to the generator system prompt. */
  systemAddendum: string;
}

export const CURATOR_DISCLAIMER =
  "Curated and assembled by Salutem Solutions LLC as a gift basket. The included items are packaged by their original manufacturers.";
export const FDA_DISCLAIMER =
  "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.";

// Shown to the model so OWN-brand products show the actual product, while gift
// baskets stay logo-free. In all cases: never show OTHER companies' logos/packaging.
const OWN_IMG = "Show the actual OWN-brand product clearly and appetizingly; our own Salutem Vita branding is acceptable. NO other companies' brand logos or packaging text. Professional high-res commercial photography, no readable third-party labels.";
const GIFT_IMG = "Premium gift-basket LIFESTYLE / in-use scene. Absolutely NO brand logos, NO packaging labels, NO readable text of ANY brand (the contents are third-party — never show their marks). Generic appetizing food / gifting presentation only.";

export const CONCEPT_CONFIG: Record<Concept, ConceptConfig> = {
  ownfood: {
    label: "Own-brand food",
    serveLabel: "Ways to serve / a simple serving idea or quick recipe",
    whatsInsideLabel: "Product details",
    disclaimer: null,
    imageSuffix: OWN_IMG,
    systemAddendum:
      "This is OUR OWN-BRAND food product (Salutem Vita / our label) — NOT a third-party product. Show our food directly (plated, fresh, appetizing). Hero = the food + its primary benefit. No curator disclaimer. Benefit cells read like icon claims (e.g. 'Ready in minutes', 'High in protein', 'Fully cooked'). The serve module = a concrete serving idea or simple recipe (name + 1 line).",
  },
  cooler: {
    label: "Cooler / container (non-food)",
    serveLabel: "How to use it",
    whatsInsideLabel: "What's in the box / sizes",
    disclaimer: null,
    imageSuffix: OWN_IMG,
    systemAddendum:
      "This is OUR OWN-BRAND non-food product: a foam cooler / insulated shipping container. Hero = the cooler product + its main benefit (keeps food cold, reusable, right-sized). Benefit cells = product benefits as icon claims (e.g. 'Holds temperature', 'Reusable', 'Multiple sizes', 'Leak-resistant'). The 'serve' module = HOW TO USE (packing frozen food, shipping, storage). What's-inside = what's in the box + size options. Do NOT use food serving/recipe language. No curator disclaimer.",
  },
  coldpack: {
    label: "Cold / gel packs (non-food)",
    serveLabel: "How to use it",
    whatsInsideLabel: "What's in the pack / sizes",
    disclaimer: null,
    imageSuffix: OWN_IMG,
    systemAddendum:
      "This is OUR OWN-BRAND non-food product: reusable ice / gel cold packs. Hero = the packs + main benefit (long-lasting cold, leakproof, food-safe, reusable). Benefit cells = icon claims ('Leakproof', 'Reusable', 'Food-safe', 'Long-lasting cold'). The 'serve' module = HOW TO USE (freeze, place in cooler/lunchbox/shipping). What's-inside = count + sizes. No food recipe language. No curator disclaimer.",
  },
  supplement: {
    label: "Supplement (own brand)",
    serveLabel: "How to take it",
    whatsInsideLabel: "Ingredients & usage",
    disclaimer: "fda",
    imageSuffix: OWN_IMG,
    systemAddendum:
      "This is OUR OWN-BRAND dietary supplement (Salutem Vita). Hero = the product + a NON-medical benefit framing (no disease/cure/treat/prevent claims — strictly forbidden). Benefit cells = factual attributes only ('Liquid formula', 'Once daily', 'Vegan', etc.). The 'serve' module = HOW TO TAKE (dosage/usage). What's-inside = ingredients & usage. An FDA disclaimer is REQUIRED and is appended automatically — do NOT make any health/medical claims.",
  },
  giftbasket: {
    label: "Gift basket (third-party contents)",
    serveLabel: "Ways to serve / occasions",
    whatsInsideLabel: "What's inside",
    disclaimer: "curator",
    imageSuffix: GIFT_IMG,
    systemAddendum:
      "This is a Salutem Vita / Starfit GIFT BASKET that contains genuine THIRD-PARTY-brand products. Carry the GIFT IDEA strongly throughout: WHO it's for and the OCCASION, framed as a curated gift. Infer the theme from the contents and build every module around it — e.g. a DOG-FOOD gift set → happy, healthy dogs and pleased dog owners (a gift for dog lovers); a BREAKFAST-SANDWICH set → convenient ready breakfasts for school / work / lunches / short trips; a READY-MEAL set → an easy heat-and-eat gift solution. Lifestyle imagery depicts that theme (e.g. happy dog + owner; family grabbing breakfast on the go) — LOGO-FREE, no third-party packaging/logos in any image. Name the included third-party brands FACTUALLY in TEXT only (e.g. 'Includes 8 Oscar Mayer Bun Length Franks'); NEVER imply a relationship (authorized/official/endorsed). A curator disclaimer is appended automatically. What's-inside = factual contents + counts.",
  },
};

const COOLER_RE = /\b(cooler|ice chest|insulated (box|container|shipping)|styrofoam|foam (box|container)|eps (box|container))\b/i;
const COLDPACK_RE = /\b(gel pack|gel packs|ice pack|ice packs|cold pack|cold packs|ice gel|reusable ice)\b/i;
const SUPPLEMENT_RE = /\b(supplement|capsule|capsules|softgel|vitamin|probiotic|collagen|detox cleanse|dietary)\b/i;
const GIFT_RE = /\b(gift basket|gift set|gift box|variety pack|variety assortment|assortment|sampler|care package|snack box|bundle of)\b/i;

/** Classify a listing into an A+ concept from its title + product type + brand. */
export function classifyConcept(itemName: string | null, productType: string | null, _brand: string | null): Concept {
  const t = itemName ?? "";
  const pt = (productType ?? "").toUpperCase();
  if (COLDPACK_RE.test(t)) return "coldpack";
  if (COOLER_RE.test(t)) return "cooler";
  if (SUPPLEMENT_RE.test(t) || /SUPPLEMENT|VITAMIN/.test(pt)) return "supplement";
  if (GIFT_RE.test(t)) return "giftbasket";
  return "ownfood";
}
