/**
 * Bundle Factory — batch progress (after "Generate listings").
 *
 * Loads the batch (GenerationJob) created from the operator's prompt, shows
 * the request back, and renders the live progress bar (BatchProgress) which
 * drives the generator and reports done / total + the current step.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead } from "@/components/kit";
import { ArrowLeft } from "lucide-react";
import { BatchProgress } from "@/components/bundle-factory/BatchProgress";

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
    select: { id: true, brief: true },
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
  const isCanonicalWalmart =
    req.workflow === "CANONICAL_WALMART_NEW_SKU";
  const walmartShipping =
    req.walmart_shipping &&
      typeof req.walmart_shipping === "object" &&
      !Array.isArray(req.walmart_shipping)
      ? req.walmart_shipping as Record<string, unknown>
      : null;
  const template =
    walmartShipping?.template &&
      typeof walmartShipping.template === "object" &&
      !Array.isArray(walmartShipping.template)
      ? walmartShipping.template as Record<string, unknown>
      : null;

  return (
    <>
      <PageHead
        title="Building listings"
        subtitle={<span>The algorithm is creating your batch. Watch it below — nothing publishes until you approve.</span>}
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

        {isCanonicalWalmart ? (
          <div className="rounded-[14px] border border-rule bg-surface p-5">
            <div className="text-[13.5px] font-semibold text-ink">
              Walmart request is ready for the canonical engine
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
              Nothing has been published. Claude Code can now execute the
              sealed Walmart workflow; every step remains visible and stops
              before live publication until the owner gate.
            </p>
            <div className="mt-4 grid gap-2 rounded-[10px] bg-bg-elev p-3 text-[12px]">
              <div>
                Account:{" "}
                <span className="font-medium text-ink">
                  {String(walmartShipping?.account_name ?? "—")}
                </span>
              </div>
              <div>
                Shipping template:{" "}
                <span className="font-medium text-ink">
                  {String(template?.name ?? "—")}
                </span>
              </div>
              <div>
                Delivery charged to buyer:{" "}
                <span className="font-medium text-ink">
                  {template?.is_free_shipping === true
                    ? "$0.00 (free shipping)"
                    : "Calculated from the selected template"}
                </span>
              </div>
              <div>
                Target margin:{" "}
                <span className="font-medium text-ink">
                  {String(req.target_margin_pct ?? 30)}%
                </span>
              </div>
            </div>
          </div>
        ) : (
          <BatchProgress batchId={job.id} />
        )}
      </div>
    </>
  );
}
