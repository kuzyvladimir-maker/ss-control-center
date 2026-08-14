// Живая страница статуса партии-3 на Рабочий стол. Вызывается автоциклом
// после каждой пачки: системный крон на macOS без Full Disk Access молча не
// выполняется, и страница застывала на час (инцидент 2026-08-11).
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

type Wave = { slug: string; total: number; title: string; price: number; comps: { flavor: string }[] };
type State = { done: string[]; failed: string[]; attempts: Record<string, number> };

const read = <T,>(p: string, fallback: T): T => {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const wave = read<Wave[]>("data/batch200/waves/b3-plan.json", []);
const state = read<State>("data/batch200/auto-state.json", { done: [], failed: [], attempts: {} });
const doneSet = new Set(state.done);
const failSet = new Set(state.failed);

const total = wave.length;
const done = wave.filter((w) => doneSet.has(w.slug)).length;
const failed = wave.filter((w) => failSet.has(w.slug)).length;
const pct = total ? Math.round((done / total) * 100) : 0;

// «Работает» = живой процесс ИЛИ свежая запись в логе. Между итерациями
// процесса нет пары секунд — раньше это показывалось как «ОСТАНОВЛЕН».
const LOG = "data/batch200/auto-loop.log";
let ageMin = 999;
if (existsSync(LOG)) ageMin = Math.floor((Date.now() - statSync(LOG).mtimeMs) / 60000);
let running = ageMin < 15;
try { execSync("pgrep -f _b2_auto", { stdio: "ignore" }); running = true; } catch { /* нет процесса */ }

const events = existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").slice(-18).reverse().map(esc)
  : [];

// Текущий слаг: первый неопубликованный в очереди.
const current = wave.find((w) => !doneSet.has(w.slug) && !failSet.has(w.slug));

const rows = wave.map((w) => {
  const st = doneSet.has(w.slug) ? "done" : failSet.has(w.slug) ? "fail"
    : w.slug === current?.slug ? "now" : "wait";
  const label = { done: "опубликован", fail: "брак", now: "собирается", wait: "в очереди" }[st];
  const flavor = w.title.replace(/^Smucker's Uncrustables Frozen Sandwich Variety Pack, /, "")
    .replace(/, \d+ Count$/, "");
  const tries = state.attempts[w.slug] ?? 0;
  return `<tr class="${st}"><td class="s"><span class="dot"></span>${label}</td>
    <td class="f">${esc(flavor)}</td><td class="n">${w.total}</td>
    <td class="n">$${w.price.toFixed(2)}</td><td class="n t">${tries || ""}</td></tr>`;
}).join("\n");

type Gap = { titleName: string; size: number; have: number | null; unlocked: number[]; donorTitle: string; image: string };
const gap = read<Gap[]>("data/batch300/art-gap.json", []);
const gapCards = gap.map((g) => `<figure>
  <img src="${esc(g.image)}" alt="${esc(g.donorTitle)}" loading="lazy">
  <figcaption><b>${esc(g.titleName)} · ${g.size} шт в коробке</b>
  <span>открывает наборы: ${g.unlocked.join(", ")}</span></figcaption></figure>`).join("\n");

const stamp = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const html = `<!doctype html>
<meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>Партия-3 — ${done} из ${total}</title>
<style>
:root{--bg:#F6F6F3;--card:#FFF;--ink:#17191D;--dim:#6B7076;--line:#E4E4DF;
      --ok:#3FA46A;--now:#D98324;--bad:#E5484D;--wait:#B9BDC2}
@media (prefers-color-scheme:dark){:root{--bg:#141618;--card:#1D2023;--ink:#ECEDEE;
      --dim:#9BA1A6;--line:#2A2E32}}
*{box-sizing:border-box}
body{font:16px/1.55 -apple-system,system-ui,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
.wrap{max-width:920px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:30px;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:var(--dim);margin:0 0 22px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
.big{display:flex;align-items:baseline;gap:14px;margin-bottom:14px}
.big b{font-size:52px;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.big span{color:var(--dim)}
.bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--ok);width:${pct}%}
.pills{display:flex;gap:22px;margin-top:14px;font-size:14px;color:var(--dim)}
.pills b{color:var(--ink);font-variant-numeric:tabular-nums}
.live{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600;
      color:${running ? "var(--ok)" : "var(--bad)"}}
.live i{width:9px;height:9px;border-radius:50%;background:currentColor}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:0 0 12px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:7px 8px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.t{color:var(--dim);font-size:12px}
.s{white-space:nowrap;width:130px;color:var(--dim)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:var(--wait)}
tr.done .dot{background:var(--ok)} tr.done .s{color:var(--ok)}
tr.now .dot{background:var(--now)} tr.now .s{color:var(--now);font-weight:600}
tr.fail .dot{background:var(--bad)} tr.fail .s{color:var(--bad)}
.f{font-weight:500}
.log{font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);
     white-space:pre-wrap;max-height:260px;overflow:auto}
.note{font-size:14px;color:var(--dim);margin:10px 0 0}
.note b{color:var(--ink)}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-top:16px}
.gal figure{margin:0}
.gal img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:10px}
.gal figcaption{font-size:12px;line-height:1.45;margin-top:7px;color:var(--dim)}
.gal figcaption b{display:block;color:var(--ink);font-size:13px}
</style>
<div class="wrap">
<h1>Партия-3 — одновкусовые наборы</h1>
<p class="sub">Обновляется само каждые 30 секунд · последнее обновление ${stamp}</p>

<div class="card">
  <div class="big"><b>${done}</b><span>из ${total} опубликовано</span>
    <span style="margin-left:auto" class="live"><i></i>${running ? "конвейер работает" : "конвейер остановлен"}</span></div>
  <div class="bar"><i></i></div>
  <div class="pills"><span>в очереди <b>${total - done - failed}</b></span>
    <span>брак <b>${failed}</b></span>
    <span>сейчас собирается <b>${current ? esc(current.slug.replace(/^b3-/, "")) : "—"}</b></span></div>
</div>

<div class="card">
  <h2>Все ${total} наборов партии</h2>
  <table>${rows}</table>
  <p class="note">Каждый набор — <b>один вкус</b>. Картинку рисует GPT Image 2 по кулерному
  якорю и точным фото коробок, затем её трижды проверяет машинный QA-офицер; непрошедшая
  картинка перерисовывается и никогда не публикуется.</p>
</div>

<div class="card">
  <h2>Ждут вашего взгляда — ${gap.length} фото коробок</h2>
  <p class="note">Движок рисует только те фасовки, чьё фото вы лично отсмотрели: реестр
  подлинности хранит по одной фасовке на вкус, и это единственное, что сейчас ограничивает
  число наборов. Утверждение этих десяти фото открывает <b>ещё 38 одновкусовых наборов</b>
  и делает возможным восстановление исторических листингов на 30 и 28 штук.
  Посмотрите, что это настоящие коробки нужного вкуса и фасовки — и скажите слово в чат.</p>
  <div class="gal">${gapCards}</div>
</div>

<div class="card">
  <h2>Последние события</h2>
  <div class="log">${events.join("\n")}</div>
</div>
</div>`;

const out = join(homedir(), "Desktop", "Листинги-статус.html");
writeFileSync(out, html);
console.log(`статус → ${out} (${done}/${total})`);
