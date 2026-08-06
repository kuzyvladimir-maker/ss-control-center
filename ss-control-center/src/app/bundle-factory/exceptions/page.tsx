/**
 * Bundle Factory — Needs attention.
 *
 * The page that makes a thousand listings reviewable: it shows only the ones
 * that need a person, and says what to do about each. Everything healthy is a
 * number in the subtitle, not a row.
 */

import Link from "next/link";
import { PageHead, Sep } from "@/components/kit";
import {
  buildWalmartExceptionQueue,
  type WalmartExceptionKind,
} from "@/lib/bundle-factory/walmart-exception-queue";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<WalmartExceptionKind, string> = {
  PUBLISHED_NOT_BUYABLE: "Live but not buyable",
  STUCK_IN_PROCESSING: "Stuck in processing",
  REJECTED: "Refused by Walmart",
  PRODUCT_ID_QUARANTINED: "Dead product ID",
  SUBMISSION_UNKNOWN: "Outcome unknown",
};

/** Worst first: silent revenue loss, then refusals, then delays. */
const KIND_TONE: Record<WalmartExceptionKind, string> = {
  PUBLISHED_NOT_BUYABLE: "border-danger/25 bg-danger-tint text-danger",
  SUBMISSION_UNKNOWN: "border-danger/25 bg-danger-tint text-danger",
  REJECTED: "border-warn-strong/40 bg-warn-tint text-warn-strong",
  PRODUCT_ID_QUARANTINED: "border-warn-strong/40 bg-warn-tint text-warn-strong",
  STUCK_IN_PROCESSING: "border-info/30 bg-info-tint text-info",
};

export default async function ExceptionsPage() {
  const queue = await buildWalmartExceptionQueue();

  return (
    <>
      <PageHead
        title="Needs attention"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {queue.exceptions.length} listing
              {queue.exceptions.length === 1 ? "" : "s"} need a person
            </span>
            <Sep />
            <span className="text-green-ink">{queue.healthy} live and healthy</span>
            <Sep />
            <span className="text-ink-3">{queue.processing} still processing</span>
          </>
        }
      />

      {queue.exceptions.length === 0 ? (
        <div className="rounded-[14px] border border-rule bg-surface px-5 py-10 text-center">
          <div className="text-[13.5px] font-medium text-ink">
            Nothing needs attention
          </div>
          <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-3">
            Every Walmart listing is either live and buyable, or inside the
            normal processing window. Listings appear here only when something
            is actually wrong.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Problem</th>
                <th className="px-3 py-2 text-left font-medium">Listing</th>
                <th className="px-3 py-2 text-left font-medium">What to do</th>
                <th className="px-3 py-2 text-right font-medium">Since</th>
              </tr>
            </thead>
            <tbody>
              {queue.exceptions.map((exception) => (
                <tr
                  key={`${exception.channelSkuId}-${exception.kind}`}
                  className="border-t border-rule align-top"
                >
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider ${KIND_TONE[exception.kind]}`}
                    >
                      {KIND_LABEL[exception.kind]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-mono text-[11.5px] text-ink-2">
                      {exception.sku}
                    </div>
                    <div className="mt-0.5 max-w-[420px] text-[12px] text-ink">
                      {exception.title}
                    </div>
                    {exception.liveUrl && (
                      <Link
                        href={exception.liveUrl}
                        target="_blank"
                        className="text-[11.5px] text-green-ink hover:underline"
                      >
                        open on Walmart
                      </Link>
                    )}
                  </td>
                  <td className="max-w-[460px] px-3 py-2.5 text-[12px] leading-snug text-ink-2">
                    {exception.detail}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[11.5px] tabular-nums text-ink-3">
                    {exception.since.toLocaleString("en-US", {
                      month: "short",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "America/New_York",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
