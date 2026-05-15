// Default rule set seeded into FrozenRule via POST /api/frozen/rules/seed.
// Editing the DB rows (Phase 4 UI, or PUT /api/frozen/rules) overrides these.

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
  // Base rules — exactly one wins (highest matching level)
  {
    ruleCode: "R1",
    ruleType: "base",
    description: "Both origin and destination cool",
    conditions: { originMax: 80, destMax: 80 },
    riskLevel: "ok",
    recommendation: null,
    priority: 10,
  },
  {
    ruleCode: "R2",
    ruleType: "base",
    description: "Mild warmth (80-85°F)",
    conditions: { tempMin: 80, tempMax: 85, applyTo: "any" },
    riskLevel: "low",
    recommendation: "Standard packing OK; Ground service is acceptable.",
    priority: 20,
  },
  {
    ruleCode: "R3",
    ruleType: "base",
    description: "Moderate heat (85-90°F)",
    conditions: { tempMin: 85, tempMax: 90, applyTo: "any" },
    riskLevel: "medium",
    recommendation: "Add +1 ice pack; prefer 2-Day Air over Ground.",
    priority: 30,
  },
  {
    ruleCode: "R4",
    ruleType: "base",
    description: "High heat (90-95°F)",
    conditions: { tempMin: 90, tempMax: 95, applyTo: "any" },
    riskLevel: "high",
    recommendation: "Add +2 ice packs; ship 2-Day or faster only.",
    priority: 40,
  },
  {
    ruleCode: "R5",
    ruleType: "base",
    description: "Extreme heat (>95°F)",
    conditions: { tempMin: 95, applyTo: "any" },
    riskLevel: "critical",
    recommendation: "Switch to Overnight; +2 ice packs minimum.",
    priority: 50,
  },
  {
    ruleCode: "R6",
    ruleType: "base",
    description: "Long transit + warm destination",
    conditions: { transitMin: 3, destMin: 85 },
    riskLevel: "critical",
    recommendation: "Cut transit time or delay shipment.",
    priority: 60,
  },
  // Modifiers — each independently bumps risk by `modifier` levels
  {
    ruleCode: "M1",
    ruleType: "modifier",
    description: "Anomalous heat in Tampa (>5°F above 30-yr norm)",
    conditions: { originAnomalyMin: 5 },
    modifier: 1,
    recommendation: "Tampa is hotter than normal for this date.",
    priority: 100,
  },
  {
    ruleCode: "M2",
    ruleType: "modifier",
    description: "Anomalous heat at destination (>5°F above norm)",
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
    description: "USPS Ground Advantage with transit ≥2 days",
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
