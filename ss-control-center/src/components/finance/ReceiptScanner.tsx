"use client";

/**
 * Receipt scanner — photograph a purchase receipt (phone camera), Claude vision
 * reads merchant/total/tax/date, you pick the fund, and it records a spend
 * (debit) against that fund. The receipt image is stored in R2.
 */

import { useRef, useState } from "react";
import { Loader2, Camera, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface FundOpt { id: string; name: string }
interface ParsedReceipt { id: string; imageUrl: string; merchant: string | null; total: number | null; tax: number | null; date: string | null }

/** Downscale a photo client-side so the upload stays small + fast. */
function fileToResizedBase64(file: File, maxDim = 1400, quality = 0.82): Promise<{ base64: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image decode failed"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ base64: canvas.toDataURL("image/jpeg", quality), contentType: "image/jpeg" });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function ReceiptScanner({ funds, defaultFundId, onSaved }: { funds: FundOpt[]; defaultFundId?: string; onSaved: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"scan" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ParsedReceipt | null>(null);
  const [form, setForm] = useState({ merchant: "", amount: "", date: "", fundId: defaultFundId ?? "" });

  async function onFile(file: File) {
    setBusy("scan"); setError(null); setReceipt(null);
    try {
      const { base64, contentType } = await fileToResizedBase64(file);
      const r = await fetch("/api/finance/receipts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "scan", image: base64, contentType }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "scan failed");
      const rc: ParsedReceipt = r.receipt;
      setReceipt(rc);
      setForm({ merchant: rc.merchant ?? "", amount: rc.total != null ? String(rc.total) : "", date: rc.date ?? "", fundId: defaultFundId ?? funds[0]?.id ?? "" });
      if (r.ocrError) setError("Couldn't read the receipt automatically — fill the fields below.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function save() {
    if (!receipt) return;
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount === 0) { setError("Enter the amount"); return; }
    if (!form.fundId) { setError("Pick a fund"); return; }
    setBusy("save"); setError(null);
    try {
      const r = await fetch("/api/finance/receipts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save", receiptId: receipt.id, fundId: form.fundId, amount, merchant: form.merchant, date: form.date || null }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "save failed");
      setReceipt(null); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      <Button onClick={() => inputRef.current?.click()} disabled={busy != null} variant="outline">
        {busy === "scan" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Camera className="mr-1 h-4 w-4" />}
        Scan receipt
      </Button>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {receipt && (
        <div className="rounded-md border p-3">
          <div className="flex gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={receipt.imageUrl} alt="receipt" className="h-28 w-20 rounded border object-cover" />
            <div className="flex flex-1 flex-wrap items-end gap-2">
              <div><label className="block text-xs text-muted-foreground">Store</label><Input className="w-40" value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} /></div>
              <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-28" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
              <div><label className="block text-xs text-muted-foreground">Date</label><Input type="date" className="w-36" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
              <div>
                <label className="block text-xs text-muted-foreground">Fund</label>
                <select value={form.fundId} onChange={(e) => setForm({ ...form, fundId: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm">
                  {funds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <Button onClick={save} disabled={busy != null} size="sm">{busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}Save (debit fund)</Button>
              <Button onClick={() => setReceipt(null)} variant="ghost" size="sm"><X className="h-4 w-4" /></Button>
            </div>
          </div>
          {receipt.tax != null && <p className="mt-1 text-xs text-muted-foreground">Tax read: ${receipt.tax}</p>}
        </div>
      )}
    </div>
  );
}
