/**
 * Bundle Factory — batch status (after "Generate listings").
 *
 * Loads the batch (GenerationJob) created from the operator's prompt and
 * shows it back honestly. The generation engine that reads the prompt,
 * sources products and assembles the listings will fill this page with
 * drafts to approve once it runs.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead } from "@/components/kit";
import { ArrowLeft, Clock } from "lucide-react";

export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Record<string, string> = {
  AMAZON_SALUTEM: "Amazon · Salutem Solutions",
  AMAZON_PERSONAL: "Amazon · Vladimir Personal",
  AMAZON_AMZCOM: "Amazon · AMZ Commerce",
  AMAZON_SIRIUS: "Amazon · Sirius International",
  AMAZON_RETAILER: "Amazon · Retailer Distributor",
  WALMART: "Walmart",
};

export default async function StudioBatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const job = await prisma.generationJob.findUnique({
    where: { id },
    select: { id: true, brief: true, status: true, created_at: true },
  });
  if (!job) notFound();

  let req: Record<string, unknown> = {};
  try {
    req = JSON.parse(job.brief ?? "{}");
  } catch {
    /* leave empty */
  }

  const prompt = typeof req.prompt === "string" ? req.prompt : "—";
  const channel = typeof req.channel === "string" ? CHANNEL_LABELS[req.channel] ?? req.channel : "—";
  const houseBrand = typeof req.house_brand === "string" ? req.house_brand : "—";
  const textModel = req.text_model === "opus" ? "Opus 4.8" : req.text_model === "sonnet" ? "Sonnet 4.6" : "—";
  const photos = req.photo_strategy === "generate" ? "Generated" : "Catalog photos";

  return (
    <>
      <PageHead
        title="Build queued"
        subtitle={<span>Your request is saved. Here&apos;s what the algorithm will build.</span>}
      />

      <Link
        href="/bundle-factory/new"
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={1.8} /> New build
      </Link>

      <div className="max-w-2xl space-y-4">
        <div className="rounded-[14px] border border-rule bg-surface p-4">
          <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">Request</div>
          <p className="mt-1.5 text-[15px] leading-relaxed text-ink">{prompt}</p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-3">
            <span>Sell on: <span className="text-ink-2">{channel}</span></span>
            <span>Brand: <span className="text-ink-2">{houseBrand}</span></span>
            <span>Model: <span className="text-ink-2">{textModel}</span></span>
            <span>Photos: <span className="text-ink-2">{photos}</span></span>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-[14px] border border-rule bg-surface-tint/50 p-4">
          <Clock size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-3" />
          <div className="text-[12.5px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">Generation engine in progress.</span> The step
            that reads your request, finds the products in the catalog and assembles the listings is
            being wired now. When it runs, your drafts will appear here to review and approve — nothing
            publishes before that.
          </div>
        </div>
      </div>
    </>
  );
}
