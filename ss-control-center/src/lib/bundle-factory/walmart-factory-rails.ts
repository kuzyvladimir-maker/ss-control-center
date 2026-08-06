/**
 * The conditions under which the factory stops itself.
 *
 * A schedule that publishes for weeks without anyone watching needs a way to
 * notice that it should stop. The daily cap bounds the volume, but volume was
 * never the danger: the danger is publishing two hundred listings that are all
 * wrong the same way, on an account that can be suspended for it.
 *
 * So the schedule asks three questions before it publishes anything:
 *
 *   Has a person pulled the handle?     — a pause that outranks the mode switch
 *   Is what we send being refused?      — an error rate that says stop guessing
 *   Do we still have product IDs?       — a pool floor, because the last few
 *                                         numbers should go to chosen listings
 *
 * The evaluation is pure and separately tested: these are the rules that decide
 * whether marketplace writes happen at all, and they must be readable without
 * a database in front of them.
 */

import { prisma } from "@/lib/prisma";

/** A person can stop the factory without changing its mode. */
export const FACTORY_PAUSED_SETTING = "walmart_factory_paused";

/** Below this many free product IDs, the schedule stops taking them. */
export const UPC_POOL_FLOOR = 50;

/** Enough recent outcomes for a failure rate to mean something. */
export const ERROR_RATE_MIN_SAMPLE = 5;

/** At or above this share of refusals, stop and let a person look. */
export const ERROR_RATE_STOP = 0.5;

/** How far back "recent" reaches when judging the error rate. */
export const ERROR_RATE_WINDOW_HOURS = 24;

export type FactoryRailBlock =
  | "PAUSED"
  | "ERROR_RATE"
  | "UPC_POOL_FLOOR";

export interface FactoryRailsInput {
  paused: boolean;
  /** Terminal outcomes inside the window. */
  recentPublished: number;
  recentRefused: number;
  /** Product IDs available and not spoken for. */
  freeUpcs: number;
}

export interface FactoryRailsVerdict {
  /** May the schedule start new publishing work? */
  allowed: boolean;
  blocks: FactoryRailBlock[];
  /** One sentence per block, for the operator and the cron's own response. */
  reasons: string[];
}

export function evaluateFactoryRails(input: FactoryRailsInput): FactoryRailsVerdict {
  const blocks: FactoryRailBlock[] = [];
  const reasons: string[] = [];

  if (input.paused) {
    blocks.push("PAUSED");
    reasons.push("The factory is paused. Nothing publishes until a person resumes it.");
  }

  const sample = input.recentPublished + input.recentRefused;
  if (sample >= ERROR_RATE_MIN_SAMPLE) {
    const rate = input.recentRefused / sample;
    if (rate >= ERROR_RATE_STOP) {
      blocks.push("ERROR_RATE");
      reasons.push(
        `${input.recentRefused} of the last ${sample} submissions were refused `
        + `(${Math.round(rate * 100)}%). Publishing more of the same is how an `
        + "account gets reviewed; the schedule stops until someone looks.",
      );
    }
  }

  if (input.freeUpcs < UPC_POOL_FLOOR) {
    blocks.push("UPC_POOL_FLOOR");
    reasons.push(
      `Only ${input.freeUpcs} free product ID(s) left (floor ${UPC_POOL_FLOOR}). `
      + "The last of them should go to listings a person chose, not to the schedule.",
    );
  }

  return { allowed: blocks.length === 0, blocks, reasons };
}

/** Read the three facts the rules need. No marketplace calls. */
export async function readFactoryRails(now: Date = new Date()): Promise<FactoryRailsVerdict & FactoryRailsInput> {
  const since = new Date(now.getTime() - ERROR_RATE_WINDOW_HOURS * 60 * 60 * 1000);
  const [paused, recentPublished, recentRefused, freeUpcs] = await Promise.all([
    isFactoryPaused(),
    prisma.channelSKU.count({
      where: { channel: "WALMART", published_at: { gte: since } },
    }),
    prisma.channelSKU.count({
      where: {
        channel: "WALMART",
        listing_status: "FAILED",
        last_error_at: { gte: since },
      },
    }),
    prisma.uPCPool.count({ where: { status: "AVAILABLE", assigned_to_id: null } }),
  ]);
  const input = { paused, recentPublished, recentRefused, freeUpcs };
  return { ...input, ...evaluateFactoryRails(input) };
}

export async function isFactoryPaused(): Promise<boolean> {
  const row = await prisma.setting.findUnique({
    where: { key: FACTORY_PAUSED_SETTING },
  });
  return row?.value?.trim().toLowerCase() === "true";
}

export async function setFactoryPaused(paused: boolean, actor: string): Promise<void> {
  const value = paused ? "true" : "false";
  await prisma.setting.upsert({
    where: { key: FACTORY_PAUSED_SETTING },
    create: { key: FACTORY_PAUSED_SETTING, value },
    update: { value },
  });
  await prisma.listingLifecycleLog.create({
    data: {
      entity_type: "Setting",
      entity_id: FACTORY_PAUSED_SETTING,
      from_status: paused ? "RUNNING" : "PAUSED",
      to_status: paused ? "PAUSED" : "RUNNING",
      trigger: paused ? "Factory paused" : "Factory resumed",
      details: JSON.stringify({ actor }),
      user_id: actor,
    },
  });
}
