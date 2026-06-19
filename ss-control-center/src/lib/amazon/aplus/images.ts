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

const IP_SAFE_SUFFIX =
  "Professional high-resolution commercial food photography, premium gift presentation, warm natural light. Absolutely NO brand logos, NO packaging labels, NO readable text or watermarks anywhere. Clean and appetizing.";

export interface ImagePlanSlot { key: string; brief: string; alt: string | null; landscape?: boolean; url?: string | null }
export interface StoredImagePlan { plan: unknown; slots: ImagePlanSlot[] }

async function gen(brief: string, slug: string, landscape: boolean): Promise<string | null> {
  const out = await generateMainImage({
    prompt: `${brief}\n\n${IP_SAFE_SUFFIX}`,
    r2_path_slug: slug,
    size: landscape ? "1536x1024" : "1024x1024",
  });
  return out.image_url ?? null;
}

/** Generate every not-yet-filled image slot for a job. Best-effort per slot. */
export async function generateImagesForJob(prisma: PrismaClient, jobId: string): Promise<{ generated: number; failed: number }> {
  const job = await prisma.amazonAplusJob.findUnique({ where: { id: jobId } });
  if (!job?.imagePlanJson) return { generated: 0, failed: 0 };
  const stored = JSON.parse(job.imagePlanJson) as StoredImagePlan;
  const slug = `aplus-${job.sku}`.toLowerCase().replace(/[^a-z0-9-]/g, "");

  let generated = 0, failed = 0;
  for (const s of stored.slots ?? []) {
    if (!s.brief || s.url) continue;
    const url = await gen(s.brief, `${slug}-${s.key}`, !!s.landscape).catch(() => null);
    if (url) { s.url = url; generated++; } else failed++;
  }
  await prisma.amazonAplusJob.update({ where: { id: jobId }, data: { imagePlanJson: JSON.stringify(stored) } });
  return { generated, failed };
}
