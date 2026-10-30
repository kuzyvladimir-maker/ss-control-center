/**
 * Persist a manual temperature class for a SKU: SkuTemperatureClass (the
 * value every reader puts first — dashboard chip, plan, rate engine) plus an
 * audit row. Never writes a Veeqo tag: mirroring tags is a separate step the
 * owner runs after review (topic 135, point 3).
 *
 * Kept out of the temp-class index so the pure modules stay DB-free.
 */

import { prisma } from "@/lib/prisma";
import type { TempClass } from "./classes";

export async function saveManualTempClass(args: {
  sku: string;
  klass: TempClass;
  setBy?: string | null;
  note?: string | null;
}): Promise<{ fromClass: string | null }> {
  const sku = args.sku.trim();
  const existing = await prisma.skuTemperatureClass.findUnique({
    where: { sku },
    select: { class: true },
  });
  const fromClass = existing?.class ?? null;
  if (fromClass === args.klass) return { fromClass };

  await prisma.skuTemperatureClass.upsert({
    where: { sku },
    create: {
      sku,
      class: args.klass,
      source: "manual",
      setBy: args.setBy ?? null,
      note: args.note ?? null,
    },
    update: {
      class: args.klass,
      source: "manual",
      setBy: args.setBy ?? null,
      note: args.note ?? null,
    },
  });
  await prisma.skuTemperatureClassChange.create({
    data: {
      sku,
      fromClass,
      toClass: args.klass,
      source: "manual",
      setBy: args.setBy ?? null,
    },
  });
  return { fromClass };
}
