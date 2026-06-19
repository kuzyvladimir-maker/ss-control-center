"use client";

/**
 * A+ Content Factory — generate professional, IP-safe A+ content for own-brand
 * listings, review it, and publish (draft → human approve → submit to Amazon).
 *
 * Flow: Scan finds own-brand listings without A+ → Generate runs the LLM + the
 * qualification gate → Review opens the storyboard (modules + image briefs +
 * any violations) → Approve → Publish (validate + create + associate + submit).
 */

import { useCallback, useEffect, useState } from "react";
import { Info, RefreshCw, Sparkles, ExternalLink, Eye, Check, X, Upload } from "lucide-react";
import { PageHead, Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

const STORES = [{ index: 1, label: "Salutem Solutions" }, { index: 3, label: "AMZ Commerce" }];

const HELP =
  "Фабрика A+ контента. «Сканировать» находит наши листинги (Salutem Vita/Starfit) БЕЗ A+. «Сгенерировать» — Claude пишет профессиональный A+ (SEO-текст + раскадровка), прогоняет через гейт квалификации (brand-voice + политика A+ + IP: чужие бренды только фактически, логотипы не в кадре). «Review» — смотришь готовый контент по модулям и комментируешь. «Approve» → «Publish» — отправка в Amazon (валидация → создание → привязка ASIN → на ревью Amazon). Ничего не публикуется без твоего approve. Картинки: брифы генерятся (lifestyle без чужих логотипов), сам слой картинок подключается отдельно.";

interface Opportunity { sku: string; asin: string; itemName: string | null; opportunityScore: number | null; revenue30d: number | null }
interface Job {
  id: string; sku: string; asin: string | null; itemName: string | null; status: string; qualified: boolean;
  concept: string | null;
  documentName: string | null; contentJson: string | null; imagePlanJson: string | null; qualificationJson: string | null;
  comments: string | null; error: string | null;
}

const CONCEPT_LABEL: Record<string, string> = {
  ownfood: "Own food", cooler: "Cooler", coldpack: "Cold packs", supplement: "Supplement", giftbasket: "Gift basket",
};

export function AplusFactory() {
  const [storeIndex, setStoreIndex] = useState(1);
  const [tab, setTab] = useState<"opportunities" | "jobs">("opportunities");
  const [scan, setScan] = useState<{ ownBrandWithout: number; ownBrandWithAplus: number; ownBrandTotal: number; opportunities: Opportunity[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [summary, setSummary] = useState<{ pending: number; needsFix: number; approved: number; published: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [review, setReview] = useState<Job | null>(null);
  const [comments, setComments] = useState("");

  const loadJobs = useCallback(async () => {
    const res = await fetch(`/api/amazon/aplus?storeIndex=${storeIndex}&view=jobs`);
    if (res.ok) { const j = await res.json(); setJobs(j.jobs ?? []); setSummary(j.summary ?? null); }
  }, [storeIndex]);
  useEffect(() => { loadJobs(); setScan(null); }, [loadJobs]);

  async function runScan() {
    setScanning(true); setMsg(null);
    try {
      const res = await fetch(`/api/amazon/aplus?storeIndex=${storeIndex}&view=scan`);
      if (res.ok) setScan((await res.json()).coverage);
    } finally { setScanning(false); }
  }

  async function post(payload: Record<string, unknown>) {
    const res = await fetch("/api/amazon/aplus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeIndex, ...payload }) });
    return res.json();
  }

  async function generate(sku: string) {
    setBusy(sku); setMsg(null);
    try {
      const j = await post({ action: "generate", sku });
      setMsg(j.ok ? (j.qualified ? "Сгенерировано ✓ — на ревью" : `Сгенерировано, но гейт нашёл нарушения (${j.violations?.length})`) : `Ошибка: ${j.error}`);
      await loadJobs();
      setTab("jobs");
    } finally { setBusy(null); }
  }
  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id);
    try { await post({ action, id, comments: comments || undefined }); setReview(null); setComments(""); await loadJobs(); }
    finally { setBusy(null); }
  }
  async function publish(id: string) {
    setBusy(id); setMsg(null);
    try {
      const j = await post({ action: "publish", id });
      setMsg(j.ok ? "Отправлено в Amazon ✓" : `Публикация не прошла: ${j.error}`);
      await loadJobs();
    } finally { setBusy(null); }
  }
  async function regenImages(jobId: string) {
    setBusy(jobId + ":img"); setMsg(null);
    try {
      await post({ action: "generateImages", id: jobId });
      const res = await fetch(`/api/amazon/aplus?storeIndex=${storeIndex}&view=jobs`);
      const data = await res.json();
      setJobs(data.jobs ?? []); setSummary(data.summary ?? null);
      const updated = (data.jobs ?? []).find((x: Job) => x.id === jobId);
      if (updated) setReview(updated);
    } finally { setBusy(null); }
  }

  const STATUS_CLR: Record<string, string> = {
    PENDING_APPROVAL: "text-warn-strong", NEEDS_FIX: "text-danger", APPROVED: "text-green-ink",
    SUBMITTED: "text-green-ink", PUBLISHED: "text-green-ink", REJECTED: "text-ink-4", FAILED: "text-danger",
  };

  return (
    <div className="space-y-5">
      <PageHead title="A+ Content Factory" subtitle="Generate professional, IP-safe A+ content for own-brand listings — review, approve, publish via SP-API" />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">Account</span>
        {STORES.map((s) => (
          <button key={s.index} onClick={() => setStoreIndex(s.index)}
            className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors", storeIndex === s.index ? "bg-green-soft text-green-ink" : "text-ink-2 hover:bg-bg-elev hover:text-ink")}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-rule bg-bg-elev/40 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
        <Info size={14} className="mt-0.5 shrink-0 text-ink-3" /><span>{HELP}</span>
      </div>

      <div className="flex items-center gap-1.5">
        {(["opportunities", "jobs"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn("rounded-md px-3 py-1.5 text-[12px] font-medium", tab === t ? "bg-green text-green-cream" : "text-ink-2 hover:bg-bg-elev")}>
            {t === "opportunities" ? "Opportunities" : "Jobs"}
          </button>
        ))}
      </div>

      {msg && <div className="rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}

      {tab === "opportunities" && (
        <Panel>
          <PanelHeader title="Own-brand listings without A+" count={scan?.ownBrandWithout}
            right={<Btn size="sm" icon={<RefreshCw size={13} />} loading={scanning} onClick={runScan}>Scan</Btn>} />
          {!scan ? (
            <div className="px-4 py-8 text-center text-[12px] text-ink-3">Жми «Scan» — найдём наши листинги без A+ (может занять ~10–20с, идёт по живому A+ API).</div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 p-4">
                <KpiCard label="Без A+" value={scan.ownBrandWithout} iconVariant="warn" />
                <KpiCard label="С A+" value={scan.ownBrandWithAplus} />
                <KpiCard label="Всего own-brand" value={scan.ownBrandTotal} />
              </div>
              <div className="max-h-[480px] overflow-auto">
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-surface"><tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-wider text-ink-3">
                    <th className="px-3 py-2">Product</th><th className="px-2 py-2">Opp</th><th className="px-2 py-2">Rev 30d</th><th className="px-2 py-2"></th>
                  </tr></thead>
                  <tbody>
                    {scan.opportunities.map((o) => (
                      <tr key={o.sku} className="border-b border-rule/50 hover:bg-bg-elev/40">
                        <td className="max-w-[420px] px-3 py-2"><div className="flex items-center gap-1"><span className="truncate text-ink">{o.itemName ?? o.sku}</span>
                          <a href={`https://www.amazon.com/dp/${o.asin}`} target="_blank" rel="noreferrer" className="shrink-0 text-ink-4 hover:text-green-ink"><ExternalLink size={12} /></a></div>
                          <span className="font-mono text-[10px] text-ink-4">{o.sku}</span></td>
                        <td className="px-2 py-2 tabular">{o.opportunityScore?.toFixed(0) ?? "—"}</td>
                        <td className="px-2 py-2 tabular">{o.revenue30d != null ? "$" + o.revenue30d.toFixed(0) : "—"}</td>
                        <td className="px-2 py-2 text-right"><Btn size="sm" variant="primary" icon={<Sparkles size={12} />} loading={busy === o.sku} onClick={() => generate(o.sku)}>Generate A+</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      )}

      {tab === "jobs" && (
        <>
          {summary && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard label="На ревью" value={summary.pending} iconVariant="warn" />
              <KpiCard label="Нужна правка" value={summary.needsFix} iconVariant={summary.needsFix > 0 ? "danger" : "default"} />
              <KpiCard label="Одобрено" value={summary.approved} />
              <KpiCard label="Опубликовано" value={summary.published} />
            </div>
          )}
          <Panel>
            <PanelHeader title="A+ jobs" count={jobs.length} right={<Btn size="sm" icon={<RefreshCw size={13} />} onClick={loadJobs}>Refresh</Btn>} />
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-wider text-ink-3">
                  <th className="px-3 py-2">Product</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Gate</th><th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>
                  {jobs.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-ink-3">Заданий нет — сгенерируй из Opportunities.</td></tr> :
                    jobs.map((j) => (
                      <tr key={j.id} className="border-b border-rule/60 hover:bg-bg-elev/40">
                        <td className="max-w-[360px] px-3 py-2"><span className="block truncate text-ink">{j.itemName ?? j.sku}</span><span className="font-mono text-[10px] text-ink-4">{j.sku}{j.concept ? ` · ${CONCEPT_LABEL[j.concept] ?? j.concept}` : ""}</span></td>
                        <td className={cn("px-2 py-2 text-[11px] font-medium", STATUS_CLR[j.status] ?? "text-ink-3")}>{j.status}{j.error && <span className="block max-w-[200px] truncate text-[10px] text-danger">{j.error}</span>}</td>
                        <td className="px-2 py-2 text-[11px]">{j.qualified ? <span className="text-green-ink">pass</span> : <span className="text-danger">{(JSON.parse(j.qualificationJson ?? "{}").violations ?? []).filter((v: { severity: string }) => v.severity === "error").length} issues</span>}</td>
                        <td className="px-2 py-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Btn size="sm" variant="outline" icon={<Eye size={12} />} onClick={() => { setReview(j); setComments(j.comments ?? ""); }}>Review</Btn>
                            {j.status === "APPROVED" && <Btn size="sm" variant="primary" icon={<Upload size={12} />} loading={busy === j.id} onClick={() => publish(j.id)}>Publish</Btn>}
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}

      {/* Review modal */}
      {review && (() => {
        const gate = review.qualificationJson ? JSON.parse(review.qualificationJson) : { violations: [] };
        const stored = review.imagePlanJson ? JSON.parse(review.imagePlanJson) : null;
        const plan = stored?.plan;
        const concept: string | undefined = stored?.concept ?? review.concept ?? undefined;
        const slots: { key: string; url?: string | null; brief?: string }[] = stored?.slots ?? [];
        const urlOf = (k: string) => slots.find((s) => s.key === k)?.url ?? null;
        const ph = (label: string) => <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400">{label}</div>;
        const img = (k: string, cls: string) => { const u = urlOf(k); return u ? <img src={u} alt="" className={cls} /> : ph("картинка генерируется…"); };
        const DISCLAIMER_TXT =
          concept === "supplement" ? "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease."
          : concept === "giftbasket" ? "Curated and assembled by Salutem Solutions LLC as a gift basket. The included items are packaged by their original manufacturers."
          : null;
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-6" onClick={() => setReview(null)}>
            <div className="my-4 w-full max-w-3xl rounded-xl border border-rule bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-start justify-between gap-2">
                <div><div className="text-[14px] font-semibold text-ink">{review.itemName ?? review.sku}</div><div className="font-mono text-[11px] text-ink-4">{review.documentName} · {review.status}</div></div>
                <button onClick={() => setReview(null)} className="text-ink-3 hover:text-ink"><X size={18} /></button>
              </div>

              {gate.violations?.length > 0 && (
                <div className="mb-3 rounded-lg border border-rule bg-bg-elev/50 p-2 text-[11px]">
                  {gate.violations.map((v: { severity: string; rule: string; found: string }, i: number) => (
                    <div key={i} className={v.severity === "error" ? "text-danger" : "text-warn-strong"}>{v.severity}: {v.rule} — «{v.found}»</div>
                  ))}
                </div>
              )}

              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] text-ink-3">Превью как на странице листинга · картинки — AI lifestyle без чужих логотипов</span>
                <Btn size="sm" variant="outline" icon={<RefreshCw size={12} />} loading={busy === review.id + ":img"} onClick={() => regenImages(review.id)}>Перегенерировать картинки</Btn>
              </div>
              {/* WYSIWYG preview — image-forward A+ landing page */}
              <div className="space-y-5 rounded-lg bg-white p-4 text-[#0f1111]">
                {!plan ? <div className="text-center text-[12px] text-gray-400">нет данных превью</div> : <>
                  {/* 1. Hero banner — benefit headline */}
                  <div>
                    {img("hero", "w-full rounded")}
                    {plan.hero?.headline && <h2 className="mt-2 text-[18px] font-semibold">{plan.hero.headline}</h2>}
                    {plan.hero?.body && <p className="text-[13px] leading-relaxed text-gray-700">{plan.hero.body}</p>}
                  </div>
                  {/* 2. Brand story — image left */}
                  <div className="flex items-start gap-4 border-t border-gray-100 pt-4">
                    <div className="w-[42%] shrink-0">{img("brandStory", "w-full rounded")}</div>
                    <div className="flex-1">{plan.brandStory?.headline && <h3 className="mb-1 text-[15px] font-semibold">{plan.brandStory.headline}</h3>}<p className="text-[13px] leading-relaxed text-gray-700">{plan.brandStory?.body}</p></div>
                  </div>
                  {/* 3. Top 3 benefits — 3-image block */}
                  <div className="border-t border-gray-100 pt-4">
                    {plan.benefits?.headline && <h3 className="mb-2 text-center text-[15px] font-semibold">{plan.benefits.headline}</h3>}
                    <div className="grid grid-cols-3 gap-3">
                      {(plan.benefits?.cells ?? []).map((c: { headline: string; body: string }, i: number) => (
                        <div key={i} className="text-center">{img(`benefit${i}`, "w-full rounded")}<div className="mt-1 text-[12px] font-semibold">{c.headline}</div><div className="text-[11px] leading-snug text-gray-600">{c.body}</div></div>
                      ))}
                    </div>
                  </div>
                  {/* 4. Ways to serve — image right */}
                  <div className="flex items-start gap-4 border-t border-gray-100 pt-4">
                    <div className="flex-1">{plan.serve?.headline && <h3 className="mb-1 text-[15px] font-semibold">{plan.serve.headline}</h3>}<p className="text-[13px] leading-relaxed text-gray-700">{plan.serve?.body}</p></div>
                    <div className="w-[42%] shrink-0">{img("serve", "w-full rounded")}</div>
                  </div>
                  {/* 5. What's inside + disclaimer */}
                  <div className="border-t border-gray-100 pt-4 text-center">
                    <h3 className="mb-1 text-[14px] font-semibold">{plan.whatsInside?.headline || "What's Inside"}</h3>
                    {plan.whatsInside?.body && <p className="mx-auto max-w-2xl text-[12px] leading-relaxed text-gray-700">{plan.whatsInside.body}</p>}
                    {DISCLAIMER_TXT && <p className="mx-auto mt-2 max-w-2xl text-[11px] leading-relaxed text-gray-500">{DISCLAIMER_TXT}</p>}
                  </div>
                </>}
              </div>

              <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Комментарии (по модулям, что поправить)…" className="mt-3 h-20 w-full rounded-lg border border-rule bg-surface p-2 text-[12px] text-ink placeholder:text-ink-4 focus:outline-none" />
              <div className="mt-3 flex items-center justify-end gap-2">
                <Btn variant="outline" icon={<X size={13} />} loading={busy === review.id} onClick={() => decide(review.id, "reject")}>Reject</Btn>
                <Btn variant="primary" icon={<Check size={13} />} loading={busy === review.id} disabled={!review.qualified} onClick={() => decide(review.id, "approve")}>Approve</Btn>
              </div>
              {!review.qualified && <div className="mt-1 text-right text-[11px] text-danger">Approve заблокирован — гейт нашёл нарушения, перегенерируй.</div>}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
