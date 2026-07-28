// Official Uncrustables manufacturer data — ingredient lists, allergen
// declarations and donor-UPC overrides for the publish conveyor.
// Extracted verbatim from scripts/_publish_batch12_stage1.ts (the proven
// batch 1+2 stage-1 runner); the script remains the fallback operator path.
// Ingredient strings are byte-identical to the published cohort — never
// reformat or "fix" them.

export type AllergenDeclaration = {
  contains: string[];
  may_contain: string[];
};

export const STD_ALLERGENS: AllergenDeclaration = { contains: ["Peanuts", "Wheat"], may_contain: ["Hazelnut", "Milk"] };
// smuckersuncrustables.com/sandwiches/hazelnut-spread-sandwich (verified 2026-07-22):
// CONTAINS HAZELNUT, MILK, AND WHEAT INGREDIENTS. MAY CONTAIN PEANUT INGREDIENTS.
export const HAZELNUT_ALLERGENS: AllergenDeclaration = { contains: ["Hazelnut", "Milk", "Wheat"], may_contain: ["Peanuts"] };
// 4ct Walmart-donor UPCs for the two flavors whose picked donors lack upc
export const UPC_OVERRIDES: Record<string, string> = {
  "Peanut Butter & Strawberry Jam": "051500048160",
  "Peanut Butter & Grape Jelly": "051500048153",
};

// Official manufacturer ingredient lists (smuckersuncrustables.com product
// pages, fetched 2026-07-22; Berry Burst from H-E-B PDP — page retired at
// manufacturer). Donors already carry ingredients for honey / chocolate /
// raspberry / hazelnut, so those are absent here and fall back to donor data.
export const INGREDIENTS: Record<string, string> = {
  "Peanut Butter & Strawberry Jam":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt. Strawberry Jam: Sugar, Strawberries, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter & Grape Jelly":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses. Grape Jelly: Sugar, Grape Juice, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses.",
  "Peanut Butter & Blueberry":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Sugar, Salt, Molasses. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Blueberry Spread: Sugar, Blueberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative), Natural Flavor.",
  "Morning Protein Peanut Butter & Mixed Berry Spread":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Sugar, Salt, Molasses. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Mixed Berry Spread: Sugar, Strawberries, Blueberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter & Blackberry Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses. Blackberry Spread: Sugar, Blackberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Natural Flavor, Potassium Sorbate (Preservative).",
  "Whole Wheat Peanut Butter & Strawberry Jam":
    "Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Contains 2% Or Less Of: Wheat Gluten, Soybean Oil, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Strawberry Spread: Sugar, Strawberries, Water, Contains 2% Or Less Of: Fruit Pectin, Citric Acid, Locust Bean Gum, Potassium Sorbate (Preservative), Calcium Chloride.",
  "Whole Wheat Peanut Butter & Grape Jelly":
    "Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Contains 2% Or Less Of: Wheat Gluten, Soybean Oil, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Grape Spread: Grapes, Sugar, Water, Fruit Pectin, Citric Acid, Locust Bean Gum, Potassium Sorbate (Preservative), Calcium Chloride.",
  "Peanut Butter & Strawberry Jam Protein":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Strawberry Jam: Sugar, Strawberries, Contains 2% Or Less Of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
  "Peanut Butter & Apple Cinnamon Jelly Protein":
    "Peanut Butter: Peanuts, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Molasses, Sugar, Salt. Bread: Unbleached Whole Wheat Flour, Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Dough Conditioner (Mono And Diglycerides, Sodium Stearoyl Lactylate, DATEM, Enzymes, Ascorbic Acid, Calcium Peroxide). Apple Cinnamon Jelly: Sugar, Apple Juice, Contains 2% Or Less Of: Pectin, Citric Acid, Cinnamon, Potassium Sorbate (Preservative).",
  "Peanut Butter & Honey Spread":
    "UNBLEACHED WHOLE WHEAT FLOUR, ENRICHED UNBLEACHED FLOUR (WHEAT FLOUR, MALTED BARLEY FLOUR, NIACIN, FERROUS SULFATE, THIAMIN MONONITRATE, RIBOFLAVIN, FOLIC ACID), WATER, SUGAR, YEAST, WHEAT GLUTEN, SOYBEAN OIL, SALT, DOUGH CONDITIONER (MONO AND DIGLYCERIDES, SODIUM STEAROYL LACTYLATE, DATEM, ENZYMES, ASCORBIC ACID, CALCIUM PEROXIDE), PEANUTS, MOLASSES, FULLY HYDROGENATED VEGETABLE OILS (RAPESEED AND SOYBEAN), HONEY, PECTIN, CITRIC ACID, POTASSIUM SORBATE, NATURAL FLAVOR, CALCIUM CHLORIDE.",
  "Peanut Butter & Chocolate Flavored Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt. Chocolate Flavored Spread: Corn Syrup, Sugar, Water, Cocoa Processed With Alkali, Contains 2% Or Less Of: Pectin, Potassium Sorbate (Preservative), Calcium Chloride, Artificial Flavor.",
  "Peanut Butter & Raspberry Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% Or Less Of: Wheat Gluten, Salt, Guar Gum, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% Or Less Of: Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Salt, Molasses. Raspberry Spread: Sugar, Raspberries, Water, Contains 2% Or Less Of: Pectin, Citric Acid, Natural Flavors, Potassium Sorbate (Preservative).",
  "Chocolate Flavored Hazelnut Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% or Less of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Chocolate Flavored Hazelnut Spread: Sugar, Vegetable Oils (Palm and Canola), Hazelnuts, Cocoa Processed with Alkali and Cocoa, Skim Milk, Whey, Contains 2% or Less of: Canola Lecithin, Vanillin (Artificial Flavor).",
  "Peanut Butter & Mixed Berry Spread":
    "Bread: Enriched Unbleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Unbleached Whole Wheat Flour, Sugar, Yeast, Soybean Oil, Contains 2% or Less of: Salt, Dough Conditioner (Enzymes, Ascorbic Acid, Calcium Peroxide). Peanut Butter: Peanuts, Sugar, Contains 2% or Less of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed and Soybean), Mono and Diglycerides, Salt. Mixed Berry Spread: Sugar, Strawberries, Blueberries, Water, Contains 2% or Less of: Pectin, Citric Acid, Potassium Sorbate (Preservative).",
};

/** Allergen declaration for a component flavor. The hazelnut sandwich is the
 *  only non-peanut-butter flavor and carries its own official declaration. */
export function allergensFor(flavor: string): AllergenDeclaration {
  return /hazelnut/i.test(flavor) && !/peanut butter &/i.test(flavor)
    ? HAZELNUT_ALLERGENS
    : STD_ALLERGENS;
}
