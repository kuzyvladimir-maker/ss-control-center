/**
 * A+ Content Factory API.
 *
 * GET  ?storeIndex&view=jobs        → A+ jobs for the store (default)
 * GET  ?storeIndex&view=scan        → live coverage scan (own-brand listings w/o A+)
 * POST { action }                   → generate | approve | reject | publish
 *
 * Nothing publishes to Amazon without the operator taking it through approve.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { scanCoverage } from "@/lib/amazon/aplus/scanner";
import { generateAplusPlan, assembleFromPlan } from "@/lib/amazon/aplus/generator";
import { qualify } from "@/lib/amazon/aplus/qualification";
import { validateContent, createContentDocument, associateAsins, submitForApproval, type AplusContentDocument } from "@/lib/amazon/aplus/client";
import { generateImagesForJob } from "@/lib/amazon/aplus/images";
import { logChange } from "@/lib/amazon/growth/change-log";

export const maxDuration = 300;

function brandOf(itemName: string | null): string {
  if (itemName && /starfit/i.test(itemName)) return "Starfit";
  return "Salutem Vita";
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const view = sp.get("view") ?? "jobs";

  if (view === "scan") {
    const cov = await scanCoverage(prisma, storeIndex);
    return NextResponse.json({ storeIndex, coverage: { ...cov, opportunities: cov.opportunities.slice(0, 200) } });
  }

  const jobs = await prisma.amazonAplusJob.findMany({
    where: { storeIndex },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const summary = {
    total: jobs.length,
    pending: jobs.filter((j) => j.status === "PENDING_APPROVAL").length,
    needsFix: jobs.filter((j) => j.status === "NEEDS_FIX").length,
    approved: jobs.filter((j) => j.status === "APPROVED").length,
    published: jobs.filter((j) => j.status === "PUBLISHED" || j.status === "SUBMITTED").length,
  };
  return NextResponse.json({ storeIndex, summary, jobs });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) ?? {}; } catch { /* */ }
  const storeIndex = Number(body.storeIndex ?? 1);
  const action = String(body.action ?? "");
  const sku = String(body.sku ?? "");
  const id = body.id ? String(body.id) : "";

  try {
    // ── generate: LLM A+ storyboard → assemble → qualification gate → store ──
    if (action === "generate") {
      if (!sku) return NextResponse.json({ ok: false, error: "sku required" }, { status: 400 });
      const item = await prisma.amazonListingHealthItem.findUnique({ where: { amazon_health_item_dedup: { storeIndex, sku } } });
      if (!item) return NextResponse.json({ ok: false, error: "listing not in mirror" }, { status: 404 });

      const plan = await generateAplusPlan({
        sku, asin: item.asin, itemName: item.itemName, productType: item.productType, brand: brandOf(item.itemName),
      });
      const doc = assembleFromPlan(plan); // text modules; images filled below
      const gate = qualify(doc);
      const imagePlan = {
        hero: { brief: plan.heroImageBrief, url: null },
        modules: plan.modules.map((m) => ({ kind: m.kind, brief: m.imageBrief ?? null, alt: m.imageAlt ?? null, url: null })),
      };

      const job = await prisma.amazonAplusJob.upsert({
        where: { amazon_aplus_job_dedup: { storeIndex, sku, variant: "A" } },
        create: {
          storeIndex, sku, asin: item.asin, itemName: item.itemName, variant: "A",
          status: gate.pass ? "PENDING_APPROVAL" : "NEEDS_FIX",
          documentName: plan.documentName, contentJson: JSON.stringify(doc),
          imagePlanJson: JSON.stringify(imagePlan), qualificationJson: JSON.stringify(gate),
          qualified: gate.pass, beforeConversion: item.unitSessionPct, generatedAt: new Date(),
        },
        update: {
          status: gate.pass ? "PENDING_APPROVAL" : "NEEDS_FIX",
          documentName: plan.documentName, contentJson: JSON.stringify(doc),
          imagePlanJson: JSON.stringify(imagePlan), qualificationJson: JSON.stringify(gate),
          qualified: gate.pass, beforeConversion: item.unitSessionPct, generatedAt: new Date(),
          error: null, comments: null,
        },
      });
      // Generate the actual images (best-effort) so the job arrives with a real preview.
      const imgRes = await generateImagesForJob(prisma, job.id).catch(() => ({ generated: 0, failed: 0 }));
      return NextResponse.json({ ok: true, action, jobId: job.id, qualified: gate.pass, violations: gate.violations, images: imgRes });
    }

    // Re-generate (or fill) the images for an existing job.
    if (action === "generateImages") {
      if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      const res = await generateImagesForJob(prisma, id);
      return NextResponse.json({ ok: true, action, ...res });
    }

    if (action === "approve" || action === "reject") {
      if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      const comments = body.comments ? String(body.comments) : undefined;
      const job = await prisma.amazonAplusJob.update({
        where: { id },
        data: { status: action === "approve" ? "APPROVED" : "REJECTED", approvedAt: action === "approve" ? new Date() : null, comments },
      });
      return NextResponse.json({ ok: true, action, status: job.status });
    }

    // ── publish: validate → create → associate ASIN → submit for approval ──
    if (action === "publish") {
      if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      const job = await prisma.amazonAplusJob.findUnique({ where: { id } });
      if (!job) return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
      if (job.status !== "APPROVED") return NextResponse.json({ ok: false, error: "must be APPROVED first" }, { status: 422 });
      if (!job.asin || !job.contentJson) return NextResponse.json({ ok: false, error: "missing asin/content" }, { status: 422 });

      const doc = JSON.parse(job.contentJson) as AplusContentDocument;
      const v = await validateContent(storeIndex, doc, [job.asin]);
      if (!v.valid) {
        await prisma.amazonAplusJob.update({ where: { id }, data: { status: "NEEDS_FIX", error: JSON.stringify(v.issues.slice(0, 5)) } });
        return NextResponse.json({ ok: false, error: "Amazon validation failed", issues: v.issues });
      }
      const key = await createContentDocument(storeIndex, doc);
      await associateAsins(storeIndex, key, [job.asin]);
      const sub = await submitForApproval(storeIndex, key);
      await prisma.amazonAplusJob.update({
        where: { id },
        data: { status: "SUBMITTED", contentReferenceKey: key, submissionId: JSON.stringify(sub).slice(0, 200), publishedAt: new Date() },
      });
      await logChange(prisma, {
        storeIndex, sku: job.sku, source: "manual", changeType: "aplus-publish", field: "aplus_content",
        beforeValue: null, afterValue: { contentReferenceKey: key, documentName: job.documentName },
        patch: [], amazonStatus: "SUBMITTED",
      }).catch(() => {});
      return NextResponse.json({ ok: true, action, contentReferenceKey: key });
    }

    return NextResponse.json({ ok: false, error: `unknown action ${action}` }, { status: 400 });
  } catch (err) {
    if (id) await prisma.amazonAplusJob.update({ where: { id }, data: { status: "FAILED", error: (err as Error).message } }).catch(() => {});
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
