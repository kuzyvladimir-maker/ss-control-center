/**
 * A+ Content Factory — image generation.
 *
 * Generates ALL image slots for a job (hero + inside + 4-grid + serve = 7) from the
 * LLM briefs via Bundle Factory's generator (OpenAI Images → R2). Premium gift-basket
 * LIFESTYLE scenes, NO third-party logos/packaging text (brands live in text only).
 * R2 URLs power the visual preview; at publish they're uploaded to Amazon's A+ Uploads API.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { generateMainImage } from "@/lib/bundle-factory/image-generation";
import { CONCEPT_CONFIG, type Concept } from "./concepts";

const DEFAULT_SUFFIX =
  "Professional high-resolution commercial food photography, warm natural light. Clean and appetizing.";
// Appended to EVERY brief, regardless of concept — gpt-image renders text as
// garbled nonsense, so we forbid it outright and keep the brand in live text.
const NO_TEXT = "Absolutely NO text, NO labels, NO logos, NO packaging copy, NO watermarks anywhere in the image. Photorealistic.";

/** Image-generation model choice. "smart" routes per slot. */
export type ImageModel = "gpt-image-2" | "gpt-image-1" | "smart";
const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2";

/** Slots we treat as infographic/diagram (cheaper model OK). None yet — all our
 *  slots are real product/lifestyle photos, where gpt-image-2 wins. Hook for later. */
function isInfographic(_slotKey: string): boolean { return false; }

function resolveModel(mode: ImageModel, slotKey: string): string {
  if (mode === "smart") return isInfographic(slotKey) ? "gpt-image-1" : "gpt-image-2";
  return mode;
}

export interface ImagePlanSlot { key: string; brief: string; alt: string | null; landscape?: boolean; url?: string | null }
export interface StoredImagePlan { plan: unknown; slots: ImagePlanSlot[] }

async function gen(brief: string, slug: string, landscape: boolean, suffix: string, model: string): Promise<string | null> {
  const out = await generateMainImage({
    prompt: `${brief}\n\n${suffix}\n\n${NO_TEXT}`,
    r2_path_slug: slug,
    size: landscape ? "1536x1024" : "1024x1024",
    model,
    quality: "high",
  });
  return out.image_url ?? null;
}

/** Generate every not-yet-filled image slot for a job. Best-effort per slot. */
export async function generateImagesForJob(
  prisma: PrismaClient,
  jobId: string,
  imageModel: ImageModel = DEFAULT_IMAGE_MODEL,
  force = false,
): Promise<{ generated: number; failed: number }> {
  const job = await prisma.amazonAplusJob.findUnique({ where: { id: jobId } });
  if (!job?.imagePlanJson) return { generated: 0, failed: 0 };
  const stored = JSON.parse(job.imagePlanJson) as StoredImagePlan;
  const slug = `aplus-${job.sku}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const suffix = CONCEPT_CONFIG[(job.concept as Concept) ?? "ownfood"]?.imageSuffix ?? DEFAULT_SUFFIX;

  let generated = 0, failed = 0;
  for (const s of stored.slots ?? []) {
    if (!s.brief || (s.url && !force)) continue;
    const model = resolveModel(imageModel, s.key);
    const url = await gen(s.brief, `${slug}-${s.key}`, !!s.landscape, suffix, model).catch(() => null);
    if (url) { s.url = url; generated++; } else failed++;
  }
  await prisma.amazonAplusJob.update({ where: { id: jobId }, data: { imagePlanJson: JSON.stringify(stored) } });
  return { generated, failed };
}
