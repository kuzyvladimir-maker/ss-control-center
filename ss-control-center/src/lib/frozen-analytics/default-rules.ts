// Default rule set, seeded into FrozenRule via the bootstrap endpoint.
//
// Thresholds reflect Vladimir's empirical observation from past summers:
//   • avg route temp < 30°C (86°F)  → standard packaging holds 3 days
//   • avg route temp ≥ 30°C (86°F)  → 3-day transit FAILS — must use 2-day
//   • ≥ 35°C (95°F)                 → even 2-day risky — go Overnight
//
// We keep all numeric values in Fahrenheit internally (Open-Meteo native
// unit), but the UI converts to °C at display time via src/lib/units.ts.

export interface DefaultRuleSpec {
  ruleCode: string;
  ruleType: "base" | "modifier";
  description: string;
  conditions: Record<string, unknown>;
  riskLevel?: string;
  modifier?: number;
  recommendation: string | null;
  priority: number;
}

export const DEFAULT_RULES: DefaultRuleSpec[] = [
  // === BASE RULES — exactly the highest matching one wins ===
  {
    ruleCode: "R1",
    ruleType: "base",
    description: "Both origin and destination clearly cool (≤ 28°C / 82°F)",
    conditions: { originMax: 82, destMax: 82 },
    riskLevel: "ok",
    recommendation: null,
    priority: 10,
  },
  {
    ruleCode: "R2",
    ruleType: "base",
    description:
      "Within 3-day packaging tolerance (max 28-30°C / 82-86°F on route)",
    conditions: { tempMin: 82, tempMax: 86, applyTo: "any" },
    riskLevel: "low",
    recommendation: "Standard packing OK; 3-day Ground acceptable.",
    priority: 20,
  },
  {
    ruleCode: "R3",
    ruleType: "base",
    description:
      "Borderline heat (max 30-32°C / 86-90°F on route) — packaging starts failing on day 3",
    conditions: { tempMin: 86, tempMax: 90, applyTo: "any" },
    riskLevel: "medium",
    recommendation: "Add +1 ice pack OR switch to 2-Day Air.",
    priority: 30,
  },
  {
    ruleCode: "R4",
    ruleType: "base",
    description:
      "High heat (max 32-35°C / 90-95°F) — 3-day transit will fail, must ship 2-day",
    conditions: { tempMin: 90, tempMax: 95, applyTo: "any" },
    riskLevel: "high",
    recommendation: "+1 ice pack and use 2-Day Air. Do not use Ground.",
    priority: 40,
  },
  {
    ruleCode: "R5",
    ruleType: "base",
    description:
      "Extreme heat (max > 35°C / 95°F) — even 2-day is risky, prefer Overnight",
    conditions: { tempMin: 95, applyTo: "any" },
    riskLevel: "critical",
    recommendation: "Switch to Overnight. +2 ice packs minimum.",
    priority: 50,
  },
  {
    ruleCode: "R6",
    ruleType: "base",
    description:
      "3+ day transit AND destination ≥ 30°C (86°F) — Vladimir's empirical rule: 3 days will not survive",
    conditions: { transitMin: 3, destMin: 86 },
    riskLevel: "critical",
    recommendation: "Shorten transit — pick 2-Day Air or delay shipment.",
    priority: 60,
  },
  // === MODIFIERS — each independently bumps the level by `modifier` levels ===
  {
    ruleCode: "M1",
    ruleType: "modifier",
    description:
      "Anomalous heat in Tampa (>5°F / ~3°C above the 30-year norm for this date)",
    conditions: { originAnomalyMin: 5 },
    modifier: 1,
    recommendation: "Tampa is hotter than normal for this date.",
    priority: 100,
  },
  {
    ruleCode: "M2",
    ruleType: "modifier",
    description:
      "Anomalous heat at destination (>5°F / ~3°C above the 30-year norm)",
    conditions: { destAnomalyMin: 5 },
    modifier: 1,
    recommendation: "Destination is hotter than normal for this date.",
    priority: 100,
  },
  {
    ruleCode: "M3",
    ruleType: "modifier",
    description: "SKU has prior thaw incidents (high/critical risk profile)",
    conditions: { skuRiskMin: "high" },
    modifier: 1,
    recommendation: "This SKU has thawed before — watch closely.",
    priority: 100,
  },
  {
    ruleCode: "M4",
    ruleType: "modifier",
    description: "USPS Ground Advantage with transit ≥ 2 days (runs slower than promised)",
    conditions: {
      carrier: "usps",
      service: "ground_advantage",
      transitMin: 2,
    },
    modifier: 1,
    recommendation: "USPS Ground Advantage runs slower than its promise.",
    priority: 100,
  },
];
