// Default rule set, seeded into FrozenRule via the bootstrap endpoint.
//
// Thresholds reflect Vladimir's empirical observation from past summers:
//   • destination temp < 30°C (86°F)  → standard packaging holds 3 days
//   • destination temp ≥ 30°C (86°F)  → 3-day transit FAILS — must use 2-day
//   • ≥ 35°C (95°F)                   → even 2-day risky — go Overnight
//
// Why destination only (decided 2026-05-15 with Vladimir): the package sits
// in his Tampa freezer until pickup, so Tampa air temperature on ship-day
// only matters during a 12-18h window (loading + initial transit). Treating
// it as the primary signal generated false-CRITICAL alerts for cool-
// destination orders all summer. Tampa now only fires through modifiers
// (M1 anomaly heat-wave, M5 absolute >35°C).
//
// All numeric thresholds are stored in Fahrenheit (Open-Meteo native unit);
// the UI converts to °C at display time via src/lib/units.ts.

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
  // === BASE RULES — destination-only; highest matching level wins ===
  {
    ruleCode: "R1",
    ruleType: "base",
    description: "Destination clearly cool (≤ 28°C / 82°F)",
    conditions: { destMax: 82 },
    riskLevel: "ok",
    recommendation: null,
    priority: 10,
  },
  {
    ruleCode: "R2",
    ruleType: "base",
    description:
      "Destination within 3-day packaging tolerance (28-30°C / 82-86°F)",
    conditions: { tempMin: 82, tempMax: 86, applyTo: "dest" },
    riskLevel: "low",
    recommendation: "Standard packing OK; 3-day Ground acceptable.",
    priority: 20,
  },
  {
    ruleCode: "R3",
    ruleType: "base",
    description:
      "Borderline destination heat (30-32°C / 86-90°F) — packaging fails on day 3",
    conditions: { tempMin: 86, tempMax: 90, applyTo: "dest" },
    riskLevel: "medium",
    recommendation: "Add +1 ice pack OR switch to 2-Day Air.",
    priority: 30,
  },
  {
    ruleCode: "R4",
    ruleType: "base",
    description:
      "High destination heat (32-35°C / 90-95°F) — 3-day transit will fail, must ship 2-day",
    conditions: { tempMin: 90, tempMax: 95, applyTo: "dest" },
    riskLevel: "high",
    recommendation: "+1 ice pack and use 2-Day Air. Do not use Ground.",
    priority: 40,
  },
  {
    ruleCode: "R5",
    ruleType: "base",
    description:
      "Extreme destination heat (> 35°C / 95°F) — even 2-day risky, prefer Overnight",
    conditions: { tempMin: 95, applyTo: "dest" },
    riskLevel: "critical",
    recommendation: "Switch to Overnight. +2 ice packs minimum.",
    priority: 50,
  },
  {
    ruleCode: "R6",
    ruleType: "base",
    description:
      "3+ day transit AND destination ≥ 30°C (86°F) — Vladimir's empirical rule: 3 days won't survive",
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
  {
    ruleCode: "M5",
    ruleType: "modifier",
    description:
      "Tampa absolute heat > 35°C (95°F) — covers the 12-18h pickup + Florida-exit window",
    conditions: { originAbsMin: 95 },
    modifier: 1,
    recommendation: "Tampa above 35°C — even short exposure during pickup adds risk.",
    priority: 100,
  },
];
