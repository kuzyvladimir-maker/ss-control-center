/**
 * Bundle Factory — "Start a build", Step 2 (pick products).
 *
 * Server component: loads the draft + a searchable slice of the Reference
 * Catalog (DonorProduct). Selection + submit live in the client picker, which
 * seeds the draft (POST .../seed → seedPoolFromDonors) and hands off to the
 * existing draft pipeline page.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead } from "@/components/kit";
import { ArrowLeft } from "lucide-react";
import { StudioDonorPicker } from "@/components/bundle-factory/StudioDonorPicker";

export const dynamic = "force-dynamic";

export default async function StudioStep2Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const draft = await prisma.bundleDraft.findUnique({
    where: { id },
    select: { id: true, draft_name: true, brand: true, pack_count: true, status: true },
  });
  if (!draft) notFound();

  const where = query
    ? {
        OR: [
          { brand: { contains: query } },
          { title: { contains: query } },
          { productLine: { contains: query } },
        ],
      }
    : {};

  const donors = await prisma.donorProduct.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    take: 60,
    select: {
      id: true,
      brand: true,
      productLine: true,
      flavor: true,
      title: true,
      size: true,
      category: true,
      mainImageUrl: true,
      bestPrice: true,
      bestRetailer: true,
    },
  });

  return (
    <>
      <PageHead
        title="Pick products"
        subtitle={
          <>
            <span className="font-medium text-ink-2">Step 2 of 3</span>
            <span className="text-ink-4">·</span>
            <span>
              Choose the products for <span className="font-medium text-ink-2">{draft.draft_name}</span>.
            </span>
          </>
        }
      />

      <Link
        href="/bundle-factory/new"
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={1.8} /> Back to config
      </Link>

      <StudioDonorPicker
        draftId={draft.id}
        initialQuery={query}
        packCount={draft.pack_count}
        products={donors.map((d) => ({
          id: d.id,
          name: d.title || [d.brand, d.productLine, d.flavor].filter(Boolean).join(" ") || "Untitled product",
          brand: d.brand,
          size: d.size,
          category: d.category,
          imageUrl: d.mainImageUrl,
          bestPrice: d.bestPrice,
          bestRetailer: d.bestRetailer,
        }))}
      />
    </>
  );
}
