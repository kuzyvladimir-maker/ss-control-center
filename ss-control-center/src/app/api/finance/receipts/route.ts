// Receipt scan → fund spend.
//   POST { action:"scan", image, contentType? }  → upload to R2 + OCR → Receipt(parsed)
//   POST { action:"save", receiptId, fundId, amount, merchant?, date? } → spend (debit fund) + link
//   GET  ?fundId=   → recent receipts (optionally for one fund)

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { uploadToR2 } from "@/lib/walmart/multipack/r2";
import { parseReceipt } from "@/lib/finance/receipt-ocr";
import { ingestReceipt } from "@/lib/finance/ingest-receipt";
import { scopeOf } from "@/lib/finance/scope";

export const maxDuration = 60;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const fundId = req.nextUrl.searchParams.get("fundId");
  const receipts = await prisma.receipt.findMany({
    where: { scope: scopeOf(req), ...(fundId ? { fundId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({ receipts });
}

export async function POST(req: NextRequest) {
  try {
    const scope = scopeOf(req);
    const b = await req.json();

    // Email auto-ingest (Jackie spec): accept one parsed record, or a batch.
    if (b.action === "ingest") {
      const records = Array.isArray(b.records) ? b.records : [b.record];
      const results = [];
      for (const rec of records) {
        if (!rec) continue;
        try { results.push({ store: rec.store, ...(await ingestReceipt(rec)) }); }
        catch (e) { results.push({ store: rec?.store, status: "error", reason: e instanceof Error ? e.message : String(e) }); }
      }
      return NextResponse.json({ ok: true, results });
    }

    if (b.action === "scan") {
      const raw = String(b.image ?? "").replace(/^data:image\/\w+;base64,/, "");
      if (!raw) return NextResponse.json({ error: "image required" }, { status: 400 });
      const buffer = Buffer.from(raw, "base64");
      const ext = (b.contentType ?? "image/jpeg").includes("png") ? "png" : "jpg";
      const key = `finance-receipts/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      let imageUrl: string;
      try {
        imageUrl = await uploadToR2(buffer, key, b.contentType ?? "image/jpeg");
      } catch (e) {
        return NextResponse.json({ ok: false, error: `upload failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
      }
      let fields;
      try {
        fields = await parseReceipt(imageUrl);
      } catch (e) {
        // Still save the image so it's not lost; let the user fill fields.
        const receipt = await prisma.receipt.create({ data: { scope, imageUrl, status: "parsed", notes: `OCR failed: ${e instanceof Error ? e.message : e}` } });
        return NextResponse.json({ ok: true, receipt, ocrError: true });
      }
      const receipt = await prisma.receipt.create({
        data: { scope, imageUrl, merchant: fields.merchant, total: fields.total, tax: fields.tax, date: fields.date, currency: fields.currency, status: "parsed", rawText: fields.raw },
      });
      return NextResponse.json({ ok: true, receipt });
    }

    if (b.action === "save") {
      const receipt = await prisma.receipt.findUnique({ where: { id: b.receiptId } });
      if (!receipt) return NextResponse.json({ error: "receipt not found" }, { status: 404 });
      const fund = await prisma.fund.findUnique({ where: { id: b.fundId } });
      if (!fund) return NextResponse.json({ error: "fund not found" }, { status: 404 });
      const amount = Math.abs(Number(b.amount));
      if (!Number.isFinite(amount) || amount === 0) return NextResponse.json({ error: "amount required" }, { status: 400 });
      const merchant = b.merchant ?? receipt.merchant ?? "Receipt";
      const date = b.date ?? receipt.date ?? null;

      // Create the spend (debit) entry + link the receipt.
      const entry = await prisma.fundEntry.create({
        data: { fundId: fund.id, type: "spend", amount: -round2(amount), description: `${merchant}${date ? ` (${date})` : ""}`, status: "applied" },
      });
      await prisma.fund.update({ where: { id: fund.id }, data: { balance: { decrement: round2(amount) } } });
      await prisma.receipt.update({
        where: { id: receipt.id },
        data: { status: "saved", fundId: fund.id, fundEntryId: entry.id, merchant, total: round2(amount), date },
      });
      return NextResponse.json({ ok: true, entry });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
