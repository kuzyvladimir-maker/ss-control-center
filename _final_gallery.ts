// Build the human review gallery from the FINAL merged audit — LIVE-defective only,
// grouped by fix ACTION (revert vs rebuild) then by defect type, each card shows the
// bad image now on Walmart + the reason. Uploaded to R2 for Vladimir.
import { readFileSync } from "node:fs";
async function main() {
  for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
  const { uploadToR2 } = await import("./src/lib/walmart/multipack/r2.ts");
  const final = JSON.parse(readFileSync("_final_audit.json", "utf8"));
  const live = final.filter((x: any) => x.defect !== "OK" && x.live === "LIVE");
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const label: Record<string, string> = {
    "wrong-product": "На картинке ДРУГОЙ товар (не тот вариант/бренд)",
    "multipack-in-cell": "В плашке сам мультипак (не одиночная единица)",
    "not-face-on": "Товар не лицом (торцом/под углом)",
    "not-multipack": "НЕ мультипак — трогать было нельзя; тайтл переписан ложно",
    "colored-bg": "Фон не белый",
    "wrong-count": "Число плашек не совпадает с паком",
    "no-image": "Нет главной картинки",
  };
  const card = (x: any) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;margin:8px 0;background:#0f1115">
    <div style="color:#ef4444;font-weight:700">${esc(x.sku)} · pack ${x.units} · ${esc(x.defect)}</div>
    <div style="color:#cbd5e1;margin:2px 0 4px;font-size:13px">${esc((x.title || "[тайтл не сохранён]").slice(0, 90))}</div>
    <div style="color:#9ca3af;font-size:12px;margin-bottom:6px"><i>${esc(String(x.reason || "").slice(0, 120))}</i></div>
    ${x.url ? `<img src="${esc(x.url)}" style="width:220px;height:220px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:220px;height:220px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">нет фото</div>`}</div>`;
  const section = (title: string, color: string, defects: string[]) => {
    const rows = live.filter((x: any) => defects.includes(x.defect));
    const byType = defects.map(d => { const r = rows.filter((x: any) => x.defect === d); return r.length ? `<h3 style="color:${color}">${esc(label[d] || d)} — ${r.length}</h3>${r.map(card).join("")}` : ""; }).join("");
    return `<section><h2 style="color:${color};border-top:2px solid ${color};padding-top:10px">${esc(title)} (${rows.length})</h2>${byType}</section>`;
  };
  const total = live.length;
  const html = `<!doctype html><meta charset=utf8><title>Финальный аудит — живой брак</title>
  <body style="background:#0b0d10;font-family:system-ui;max-width:1040px;margin:0 auto;padding:24px;color:#e5e7eb">
  <h1 style="color:#fff">Финальный аудит: живой брак на Walmart</h1>
  <div style="color:#9ca3af;margin-bottom:14px">Тронули <b>743</b> листинга · чистых и живых <b style="color:#22c55e">336</b> · <b style="color:#ef4444">${total}</b> живых дефектных (реальный ущерб) · 39 не прошли ingestion (безопасны).<br>Проверено на трёх уровнях: строгие гейты + независимый второй судья + item-level статус прямо с Walmart.</div>
  ${section("REVERT — откатить (нельзя было трогать)", "#f59e0b", ["not-multipack"])}
  ${section("REBUILD — пересобрать новым движком", "#ef4444", ["wrong-product", "multipack-in-cell", "not-face-on", "colored-bg", "wrong-count", "no-image"])}
  </body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/final-audit.html`, "text/html");
  console.log("GALLERY:", gu);
  console.log("live-defective:", total, "revert:", live.filter((x: any) => x.defect === "not-multipack").length, "rebuild:", total - live.filter((x: any) => x.defect === "not-multipack").length);
}
main().catch(e => { console.error(e); process.exit(1); });
