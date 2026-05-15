// Rule evaluator for proactive frozen-risk scoring.
//
// Reads enabled rules from the FrozenRule table at runtime. Base rules pick
// the highest matching risk level; modifier rules then independently bump
// that level by their `modifier` value, capped at "critical". The same
// engine is used by the pipeline and (eventually) by the Phase 4 rule editor
// for dry-runs.

import { prisma } from "@/lib/prisma";

export interface RuleContext {
  originTempF: number | null;
  destTempF: number | null;
  originAnomalyF: number | null;
  destAnomalyF: number | null;
  transitDays: number | null;
  carrier: string | null;
  service: string | null;
  sku: string;
  skuRiskLevel?: string | null; // from SkuRiskProfile
}

export interface RuleResult {
  riskLevel: string;
  riskScore: number; // 0-100
  triggeredRules: string[]; // ["R3", "M1"]
}

export const LEVEL_ORDER = ["ok", "low", "medium", "high", "critical"] as const;
type LevelStr = (typeof LEVEL_ORDER)[number];

interface BaseCond {
  applyTo?: string;
  tempMin?: number;
  tempMax?: number;
  originMin?: number;
  originMax?: number;
  destMin?: number;
  destMax?: number;
  transitMin?: number;
}

interface ModifierCond {
  originAnomalyMin?: number;
  destAnomalyMin?: number;
  skuRiskMin?: string;
  carrier?: string;
  service?: string;
  transitMin?: number;
}

function levelRank(level: string): number {
  const idx = LEVEL_ORDER.indexOf(level as LevelStr);
  return idx < 0 ? 0 : idx;
}

function bumpLevel(level: string, by: number): string {
  const idx = Math.min(levelRank(level) + by, LEVEL_ORDER.length - 1);
  return LEVEL_ORDER[idx];
}

function levelToScore(level: string): number {
  const map: Record<string, number> = {
    ok: 5,
    low: 25,
    medium: 50,
    high: 75,
    critical: 95,
  };
  return map[level] ?? 0;
}

function matchesBaseRule(cond: BaseCond, ctx: RuleContext): boolean {
  // applyTo: "any" means apply tempMin/tempMax to max(origin, dest)
  if (cond.applyTo === "any") {
    const maxTemp = Math.max(ctx.originTempF ?? -999, ctx.destTempF ?? -999);
    if (maxTemp === -999) return false; // no weather data
    if (cond.tempMin != null && maxTemp < cond.tempMin) return false;
    if (cond.tempMax != null && maxTemp >= cond.tempMax) return false;
    return true;
  }

  // Specific origin / dest / transit checks. Missing values are treated
  // generously so a rule that ONLY mentions e.g. destMin doesn't accidentally
  // fail because origin is null.
  if (cond.originMax != null) {
    if (ctx.originTempF == null) return false;
    if (ctx.originTempF > cond.originMax) return false;
  }
  if (cond.destMax != null) {
    if (ctx.destTempF == null) return false;
    if (ctx.destTempF > cond.destMax) return false;
  }
  if (cond.destMin != null) {
    if (ctx.destTempF == null) return false;
    if (ctx.destTempF < cond.destMin) return false;
  }
  if (cond.originMin != null) {
    if (ctx.originTempF == null) return false;
    if (ctx.originTempF < cond.originMin) return false;
  }
  if (cond.transitMin != null) {
    if (ctx.transitDays == null) return false;
    if (ctx.transitDays < cond.transitMin) return false;
  }
  // Must have specified at least one condition that matched.
  const hasAnyCondition =
    cond.originMax != null ||
    cond.destMax != null ||
    cond.destMin != null ||
    cond.originMin != null ||
    cond.transitMin != null;
  return hasAnyCondition;
}

function matchesModifierRule(cond: ModifierCond, ctx: RuleContext): boolean {
  if (cond.originAnomalyMin != null) {
    return (ctx.originAnomalyF ?? -999) >= cond.originAnomalyMin;
  }
  if (cond.destAnomalyMin != null) {
    return (ctx.destAnomalyF ?? -999) >= cond.destAnomalyMin;
  }
  if (cond.skuRiskMin != null) {
    if (!ctx.skuRiskLevel) return false;
    return levelRank(ctx.skuRiskLevel) >= levelRank(cond.skuRiskMin);
  }
  if (cond.carrier != null) {
    if (ctx.carrier?.toLowerCase() !== cond.carrier.toLowerCase()) return false;
    if (
      cond.service &&
      !ctx.service
        ?.toLowerCase()
        .includes(cond.service.replace(/_/g, " ").toLowerCase())
    ) {
      return false;
    }
    if (cond.transitMin != null && (ctx.transitDays ?? -1) < cond.transitMin) {
      return false;
    }
    return true;
  }
  return false;
}

export async function evaluateRisk(ctx: RuleContext): Promise<RuleResult> {
  const rules = await prisma.frozenRule.findMany({
    where: { enabled: true },
    orderBy: [{ ruleType: "asc" }, { priority: "asc" }],
  });

  let baseLevel = "ok";
  const triggered: string[] = [];

  // Pass 1: base rules — pick highest matching level
  for (const rule of rules.filter((r) => r.ruleType === "base")) {
    let cond: BaseCond;
    try {
      cond = JSON.parse(rule.conditions) as BaseCond;
    } catch {
      continue;
    }
    if (matchesBaseRule(cond, ctx)) {
      triggered.push(rule.ruleCode);
      if (levelRank(rule.riskLevel ?? "ok") > levelRank(baseLevel)) {
        baseLevel = rule.riskLevel ?? "ok";
      }
    }
  }

  // Pass 2: modifiers — each adds `modifier` levels
  let finalLevel = baseLevel;
  for (const rule of rules.filter((r) => r.ruleType === "modifier")) {
    let cond: ModifierCond;
    try {
      cond = JSON.parse(rule.conditions) as ModifierCond;
    } catch {
      continue;
    }
    if (matchesModifierRule(cond, ctx)) {
      triggered.push(rule.ruleCode);
      finalLevel = bumpLevel(finalLevel, rule.modifier ?? 1);
    }
  }

  return {
    riskLevel: finalLevel,
    riskScore: levelToScore(finalLevel),
    triggeredRules: triggered,
  };
}
