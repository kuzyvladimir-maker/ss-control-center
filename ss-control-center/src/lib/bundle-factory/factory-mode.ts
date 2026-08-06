/**
 * How much the factory is allowed to do on its own.
 *
 * Owner decision 2026-08-05: the schedule should run the whole line either
 * automatically or semi-automatically, "depending on a switch that I or my
 * staff set in this module". So the mode is data an operator changes, not a
 * constant a developer changes.
 *
 *   SEMI_AUTO — the schedule BUILDS listings and stops there. Publishing waits
 *               for a person to look at the batch and press. This is the
 *               default: publication is the owner's decision until he says
 *               otherwise, and a new schedule should never surprise him with
 *               live listings.
 *
 *   AUTO      — the schedule also PUBLISHES, inside the daily ceiling
 *               (`walmart_publish_daily_cap`, derived from Walmart's feed
 *               throughput, not a hand-picked number). The owner's decision
 *               moves from "press for each batch" to "this ceiling, this mode",
 *               which is what makes a factory run for weeks unattended.
 *
 * Both modes obey every safety fence identically. The mode decides whether
 * publishing STARTS on its own, never whether it is checked.
 */

import { prisma } from "@/lib/prisma";

export const FACTORY_MODE_SETTING = "walmart_factory_mode";

export const FACTORY_MODES = ["SEMI_AUTO", "AUTO"] as const;
export type FactoryMode = (typeof FACTORY_MODES)[number];

/** Safe by default: build, but never publish unasked. */
export const FACTORY_MODE_DEFAULT: FactoryMode = "SEMI_AUTO";

export function isFactoryMode(value: unknown): value is FactoryMode {
  return typeof value === "string"
    && (FACTORY_MODES as readonly string[]).includes(value);
}

export async function readFactoryMode(): Promise<FactoryMode> {
  const row = await prisma.setting.findUnique({
    where: { key: FACTORY_MODE_SETTING },
  });
  const value = row?.value?.trim().toUpperCase();
  return isFactoryMode(value) ? value : FACTORY_MODE_DEFAULT;
}

export async function writeFactoryMode(
  mode: FactoryMode,
  actor: string,
): Promise<FactoryMode> {
  if (!isFactoryMode(mode)) throw new Error(`Unknown factory mode ${mode}`);
  await prisma.setting.upsert({
    where: { key: FACTORY_MODE_SETTING },
    create: { key: FACTORY_MODE_SETTING, value: mode },
    update: { value: mode },
  });
  // Flipping to AUTO is the moment publishing stops needing a press; that is a
  // decision worth being able to point at later.
  await prisma.listingLifecycleLog.create({
    data: {
      entity_type: "Setting",
      entity_id: FACTORY_MODE_SETTING,
      to_status: mode,
      trigger: "Walmart factory mode changed",
      user_id: actor,
    },
  }).catch(() => {
    // The mode is set either way; the audit line is best-effort.
  });
  return mode;
}
