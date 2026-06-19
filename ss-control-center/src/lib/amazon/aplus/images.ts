/**
 * A+ Content Factory — image generation.
 *
 * Turns the LLM's per-module image briefs into real images via the existing
 * Bundle Factory generator (OpenAI Images → hosted on R2), so the review modal can
 * show a real visual preview. Images are premium gift-basket LIFESTYLE scenes with
 * NO third-party logos/packaging text — the IP-safe rule (brands live in text only).
 *
 * R2 URLs are for preview + are uploaded to Amazon's A+ Uploads API at publish time
 * (publish step) to obtain uploadDestinationIds.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { generateMainImage } from "@/lib/bundle-factory/image-generation";

// Appended to every brief so the model never renders brand marks or text.
const IP_SAFE_SUFFIX =
  "Professional high-resolution commercial photography. Absolutely NO brand logos, NO packaging labels, NO readable text or watermarks anywhere in the image. Clean, premium, well-lit.";

export interface ImagePlanModule { kind: string; brief: string | null; alt: string | null; url?: string | null }
export interface ImagePlan { hero: { brief: string; url?: string | null }; modules: ImagePlanModule[] }

async function gen(brief: string, slug: string, landscape: boolean): Promise<string | null> {
  const out = await generateMainImage({
    prompt: `${brief}\n\n${IP_SAFE_SUFFIX}`,
    r2_path_slug: slug,
    size: landscape ? "1536x1024" : "1024x1024",
  });
  return out.image_url ?? null;
}

/** Generate all images for a job's plan; fills .url fields. Best-effort per image. */
export async function generateImagesForJob(prisma: PrismaClient, jobId: string): Promise<{ generated: number; failed: number }> {
  const job = await prisma.amazonAplusJob.findUnique({ where: { id: jobId } });
  if (!job?.imagePlanJson) return { generated: 0, failed: 0 };
  const plan = JSON.parse(job.imagePlanJson) as ImagePlan;
  const slug = `aplus-${job.sku}`.toLowerCase();

  let generated = 0, failed = 0;

  // Hero (landscape).
  if (plan.hero?.brief && !plan.hero.url) {
    const url = await gen(plan.hero.brief, `${slug}-hero`, true).catch(() => null);
    if (url) { plan.hero.url = url; generated++; } else failed++;
  }
  // Per-module images that have a brief.
  for (let i = 0; i < (plan.modules?.length ?? 0); i++) {
    const m = plan.modules[i];
    if (!m.brief || m.url) continue;
    const landscape = m.kind === "header";
    const url = await gen(m.brief, `${slug}-m${i}`, landscape).catch(() => null);
    if (url) { m.url = url; generated++; } else failed++;
  }

  await prisma.amazonAplusJob.update({ where: { id: jobId }, data: { imagePlanJson: JSON.stringify(plan) } });
  return { generated, failed };
}
