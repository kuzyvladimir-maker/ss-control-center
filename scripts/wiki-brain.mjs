#!/usr/bin/env node
// =============================================================================
//  WIKI-BRAIN — «иммунная система» базы знаний проекта SS Control Center
// =============================================================================
//
//  ЗАЧЕМ ЭТО (простыми словами для Владимира):
//  У нас есть «вики-мозг» — папка docs/wiki/ (статьи-алгоритмы) и память
//  (~/.claude/.../memory/). Раньше актуальность держалась на ручной дисциплине:
//  надо было не забыть дописать статью, добавить ссылку, обновить оглавление.
//  Человек (и я) такое забывает → появляются «файлы-сироты» (на них никто не
//  ссылается) и «битые ссылки» (ссылка ведёт в никуда). Мозг дряхлеет.
//
//  Этот скрипт — АВТОМАТИЧЕСКИЙ САНИТАР. Он сам:
//    1. находит сирот    — вики-файлы, на которые никто не ссылается;
//    2. находит тупики    — файлы, которые сами ни на что не ссылаются;
//    3. находит битые ссылки — ссылки на несуществующие файлы;
//    4. сверяет память    — заметки memory/*.md vs индекс MEMORY.md;
//    5. ловит «дрейф»     — код поменяли, а доку к нему не тронули.
//
//  Он НЕ пишет текст статей сам (это делаю я, Claude). Его работа — НЕ ДАТЬ
//  мозгу зарасти: поймать проблему и ткнуть носом. А «ткнуть носом
//  автоматически, без надежды на память» — это делают хуки Claude Code
//  (.claude/settings.json), которые запускают этот скрипт в нужный момент.
//
//  ЗАПУСК ВРУЧНУЮ (из корня репозитория):
//    node scripts/wiki-brain.mjs            # полный аудит, человекочитаемо
//    node scripts/wiki-brain.mjs --json     # то же, машинно (JSON)
//    node scripts/wiki-brain.mjs --graph    # + пересобрать граф связей в .brain-graph.json
//
//  РЕЖИМЫ ДЛЯ ХУКОВ (вызываются автоматически, читают payload из stdin):
//    hook-postedit   — после Write/Edit: проверить именно изменённый файл;
//    hook-stop       — при завершении ответа: проверить незакоммиченные изменения;
//    hook-session    — на старте сессии: показать одну строку статуса мозга.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// --- Пути ---------------------------------------------------------------------
// fileURLToPath обязателен: путь содержит пробел ("SS Command Center"), и без
// декодирования он превратился бы в "SS%20Command%20Center" → файлы не найдутся.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI_DIR = path.join(REPO_ROOT, 'docs', 'wiki');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const APP_SRC = path.join(REPO_ROOT, 'ss-control-center', 'src');
const MEMORY_DIR = path.join(
  os.homedir(),
  '.claude', 'projects', '-Users-vladimirkuznetsov-SS-Command-Center', 'memory',
);
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

// Файлы-«хабы»: оглавление и карта связей. Им сиротство прощается — это корни графа.
const HUB_FILES = new Set(['index.md', 'CONNECTIONS.md', 'SESSION-HANDOFF.md']);

// --- Мелкие утилиты -----------------------------------------------------------
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => fs.readFileSync(p, 'utf8');

/** Рекурсивно собрать все *.md внутри каталога. Возвращает абсолютные пути. */
function listMarkdown(dir) {
  const out = [];
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...listMarkdown(full));
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Вытащить из markdown все внутренние ссылки на .md-файлы.
 * Игнорируем картинки (![]()), внешние ссылки (http), якоря (#...), mailto.
 * Возвращаем массив { target, raw } где target — путь как он написан.
 */
function extractMdLinks(content) {
  const links = [];
  const re = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const isImage = m[1] === '!';
    let target = m[2].trim();
    if (isImage) continue;
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    target = target.split('#')[0]; // отрезаем якорь #section
    if (!target) continue;
    if (!target.toLowerCase().endsWith('.md')) continue;
    links.push(target);
  }
  return links;
}

/** Вытащить [[wiki-style]] ссылки (формат памяти). */
function extractWikilinks(content) {
  const links = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) links.push(m[1].trim());
  return links;
}

// =============================================================================
//  ЯДРО АНАЛИЗА
// =============================================================================
function analyze() {
  const wikiFiles = listMarkdown(WIKI_DIR);
  const docsFiles = new Set(listMarkdown(DOCS_DIR).map((p) => path.resolve(p)));

  // rel — относительный путь от docs/wiki (удобно для отчётов): "shipping-labels.md", "design/index.md"
  const relWiki = (abs) => path.relative(WIKI_DIR, abs);

  const inbound = new Map();   // abs -> Set(abs) кто на меня ссылается (внутри вики)
  const outbound = new Map();  // abs -> Set(abs) на кого я ссылаюсь (внутри вики)
  const broken = [];           // { from, target } битые ссылки
  for (const f of wikiFiles) { inbound.set(f, new Set()); outbound.set(f, new Set()); }

  for (const file of wikiFiles) {
    const dir = path.dirname(file);
    for (const target of extractMdLinks(read(file))) {
      const resolved = path.resolve(dir, target);
      if (!exists(resolved)) {
        // Битая ссылка — только если цель явно внутри docs/ (а не внешний артефакт)
        broken.push({ from: relWiki(file), target });
        continue;
      }
      // Ребро графа считаем только между вики-файлами
      if (outbound.has(file) && inbound.has(resolved)) {
        outbound.get(file).add(resolved);
        inbound.get(resolved).add(file);
      }
    }
  }

  // Сироты: вики-файл (не хаб), на который НЕ ссылается ни один другой вики-файл.
  const orphans = [];
  // Тупики: вики-файл (не хаб), который сам НИ НА ЧТО не ссылается.
  const deadends = [];
  for (const file of wikiFiles) {
    const name = path.basename(file);
    const inDesignIndex = path.basename(path.dirname(file)) === 'design' && name === 'index.md';
    if (HUB_FILES.has(name) || inDesignIndex) continue;
    if (inbound.get(file).size === 0) orphans.push(relWiki(file));
    if (outbound.get(file).size === 0) deadends.push(relWiki(file));
  }

  // --- Память: сверка memory/*.md с индексом MEMORY.md ---
  // ВАЖНО про [[link]] в памяти: по спецификации памяти голый [[slug]] МОЖЕТ
  // указывать на ещё не созданную заметку — это НЕ ошибка, а пометка «написать
  // позже». Поэтому голые слаги мы не трогаем. Ругаемся только на [[путь]]-ссылки
  // (содержащие «/» или «.md»), ведущие в реально несуществующий файл.
  const memProblems = { unindexed: [], stalePointers: [], brokenPaths: [] };
  if (exists(MEMORY_DIR)) {
    const memFiles = listMarkdown(MEMORY_DIR)
      .map((p) => path.basename(p))
      .filter((n) => n !== 'MEMORY.md');
    const memSet = new Set(memFiles);
    const indexContent = exists(MEMORY_INDEX) ? read(MEMORY_INDEX) : '';
    // 1. заметки, не упомянутые в индексе
    for (const n of memFiles) {
      if (!indexContent.includes(n)) memProblems.unindexed.push(n);
    }
    // 2. указатели индекса на несуществующие файлы
    for (const target of extractMdLinks(indexContent)) {
      const base = path.basename(target);
      if (!memSet.has(base)) memProblems.stalePointers.push(base);
    }
    // 3. [[путь]]-ссылки в заметках, ведущие в несуществующий файл (репо или память)
    for (const f of listMarkdown(MEMORY_DIR)) {
      if (path.basename(f) === 'MEMORY.md') continue;
      for (const link of extractWikilinks(read(f))) {
        const looksLikePath = link.includes('/') || link.toLowerCase().endsWith('.md');
        if (!looksLikePath) continue; // голый слаг — допустимая «ссылка-намерение»
        const candidates = [path.resolve(REPO_ROOT, link), path.resolve(MEMORY_DIR, link)];
        if (!candidates.some(exists)) {
          memProblems.brokenPaths.push(`${path.basename(f)} → [[${link}]]`);
        }
      }
    }
  }

  return {
    wikiFiles, relWiki, inbound, outbound,
    orphans, deadends, broken, memProblems,
    docsFiles,
  };
}

// --- «Дрейф»: код поменяли, а доку не тронули (по незакоммиченным изменениям) --
function gitDrift() {
  let porcelain = '';
  try {
    porcelain = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch { return { codeChanged: [], docsChanged: [], drift: false }; }
  const paths = porcelain.split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => p.replace(/^"|"$/g, ''));
  const codeChanged = paths.filter((p) =>
    p.startsWith('ss-control-center/src/') && /\.(ts|tsx|js|jsx)$/.test(p) && !/\.(test|spec)\./.test(p));
  const docsChanged = paths.filter((p) => p.startsWith('docs/'));
  return { paths, codeChanged, docsChanged, drift: codeChanged.length > 0 && docsChanged.length === 0 };
}

// =============================================================================
//  ОТЧЁТЫ
// =============================================================================
function report(a) {
  const lines = [];
  const total = a.wikiFiles.length;
  let edges = 0;
  for (const s of a.outbound.values()) edges += s.size;

  lines.push('🧠 WIKI-BRAIN — аудит базы знаний');
  lines.push(`   статей: ${total}   связей: ${edges}   сирот: ${a.orphans.length}   битых ссылок: ${a.broken.length}`);
  lines.push('');

  if (a.orphans.length) {
    lines.push(`🔸 СИРОТЫ (${a.orphans.length}) — ни один файл на них не ссылается, добавь в index.md/CONNECTIONS.md:`);
    for (const o of a.orphans) lines.push(`   • ${o}`);
    lines.push('');
  }
  if (a.broken.length) {
    lines.push(`🔴 БИТЫЕ ССЫЛКИ (${a.broken.length}):`);
    for (const b of a.broken) lines.push(`   • ${b.from} → ${b.target}`);
    lines.push('');
  }
  if (a.deadends.length) {
    lines.push(`🔹 ТУПИКИ (${a.deadends.length}) — сами ни на что не ссылаются (мягкое предупреждение):`);
    for (const d of a.deadends) lines.push(`   • ${d}`);
    lines.push('');
  }
  const mp = a.memProblems;
  if (mp.unindexed.length || mp.stalePointers.length || mp.brokenPaths.length) {
    lines.push('🟣 ПАМЯТЬ:');
    for (const n of mp.unindexed) lines.push(`   • не в индексе MEMORY.md: ${n}`);
    for (const n of mp.stalePointers) lines.push(`   • индекс ссылается на отсутствующий файл: ${n}`);
    for (const n of mp.brokenPaths) lines.push(`   • битая ссылка-путь: ${n}`);
    lines.push('');
  }

  if (!a.orphans.length && !a.broken.length && !mp.unindexed.length && !mp.stalePointers.length && !mp.brokenPaths.length) {
    lines.push('✅ Граф связный, сирот и битых ссылок нет.');
  }
  return lines.join('\n');
}

/** Записать машинный граф связей в docs/wiki/.brain-graph.json (для отладки/будущего). */
function writeGraph(a) {
  const nodes = a.wikiFiles.map((f) => ({
    id: a.relWiki(f),
    inbound: a.inbound.get(f).size,
    outbound: a.outbound.get(f).size,
  }));
  const edgeList = [];
  for (const [from, set] of a.outbound) {
    for (const to of set) edgeList.push({ from: a.relWiki(from), to: a.relWiki(to) });
  }
  // «God nodes» — самые «центральные» статьи (много входящих ссылок)
  const godNodes = [...nodes].sort((x, y) => y.inbound - x.inbound).slice(0, 10);
  const graph = {
    generatedNote: 'Auto-derived by scripts/wiki-brain.mjs. Do not edit by hand.',
    stats: { nodes: nodes.length, edges: edgeList.length, orphans: a.orphans.length, broken: a.broken.length },
    godNodes,
    nodes,
    edges: edgeList,
  };
  fs.writeFileSync(path.join(WIKI_DIR, '.brain-graph.json'), JSON.stringify(graph, null, 2));
}

// =============================================================================
//  ХУК-РЕЖИМЫ (читают JSON-payload Claude Code из stdin)
// =============================================================================
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function parsePayload() {
  try { return JSON.parse(readStdin() || '{}'); } catch { return {}; }
}

/** PostToolUse(Write|Edit): проверить ИМЕННО изменённый вики/память-файл. */
function hookPostEdit() {
  const p = parsePayload();
  const filePath = p?.tool_input?.file_path || p?.tool_input?.path || '';
  if (!filePath) process.exit(0);
  const abs = path.resolve(filePath);
  const inWiki = abs.startsWith(WIKI_DIR + path.sep);
  const inMemory = abs.startsWith(MEMORY_DIR + path.sep);
  if (!inWiki && !inMemory) process.exit(0); // нас интересуют только мозг/память
  if (!exists(abs)) process.exit(0);

  const a = analyze();
  const msgs = [];

  if (inWiki) {
    const rel = a.relWiki(abs);
    const name = path.basename(abs);
    const isHub = HUB_FILES.has(name);
    // битые ссылки в этом файле
    const myBroken = a.broken.filter((b) => b.from === rel);
    if (myBroken.length) {
      msgs.push(`битые ссылки в ${rel}: ${myBroken.map((b) => b.target).join(', ')}`);
    }
    // новая статья без входящих ссылок (сирота) — ЖЁСТКАЯ проблема, блокируем
    if (!isHub && a.inbound.get(abs)?.size === 0) {
      msgs.push(`${rel} — СИРОТА: на неё никто не ссылается. Добавь ссылку в docs/wiki/index.md и/или CONNECTIONS.md.`);
    }
    // «тупик» (файл сам ни на что не ссылается) — МЯГКАЯ проблема: не блокируем
    // на каждом редактировании (это норма для листовых статей), показываем
    // только в ручном аудите `node scripts/wiki-brain.mjs`.
  }

  if (inMemory && path.basename(abs) !== 'MEMORY.md') {
    const name = path.basename(abs);
    const idx = exists(MEMORY_INDEX) ? read(MEMORY_INDEX) : '';
    if (!idx.includes(name)) {
      msgs.push(`Заметка памяти ${name} не добавлена в MEMORY.md — добавь строку-указатель.`);
    }
  }

  if (msgs.length) {
    process.stderr.write('🧠 wiki-brain: ' + msgs.join(' | ') + '\n');
    process.exit(2); // exit 2 → текст уходит мне (Claude) как обратная связь
  }
  process.exit(0);
}

/**
 * Stop: при завершении ответа проверить ТО, ЧТО ЗАДЕТО В ЭТОЙ СЕССИИ.
 * Принцип: ругаемся только на проблемы в незакоммиченных файлах (git status),
 * а не на глобальное состояние мозга — иначе хук дёргал бы на каждом ответе,
 * пока вся вики не идеальна. Глобальную гигиену показывает hook-session + ручной аудит.
 * Loop-safe: при stop_hook_active=true выходим тихо (один блок на завершение).
 */
function hookStop() {
  const p = parsePayload();
  if (p?.stop_hook_active) process.exit(0);

  const git = gitDrift();
  if (!git.paths.length) process.exit(0); // ничего не меняли — не мешаем (read-only сессия)

  const a = analyze();
  // Набор изменённых вики-файлов (относительно docs/wiki) для точечной проверки
  const changedWiki = new Set(
    git.paths
      .filter((p) => p.startsWith('docs/wiki/'))
      .map((p) => path.relative('docs/wiki', p)),
  );
  const msgs = [];

  // Сироты — только если осиротевший файл сам изменён в этой сессии (новый/тронутый)
  const newOrphans = a.orphans.filter((o) => changedWiki.has(o));
  if (newOrphans.length) msgs.push(`новые сироты: ${newOrphans.join(', ')} — добавь в index.md/CONNECTIONS.md`);

  // Битые ссылки — только в изменённых файлах
  const newBroken = a.broken.filter((b) => changedWiki.has(b.from));
  if (newBroken.length) msgs.push(`битые ссылки: ${newBroken.map((b) => `${b.from}→${b.target}`).join(', ')}`);

  // Дрейф код↔доки
  if (git.drift) {
    msgs.push(`код менялся (${git.codeChanged.length} файл(ов) в src/), но docs/ не тронут — обнови вики или подтверди, что не нужно`);
  }

  if (msgs.length) {
    process.stderr.write('🧠 wiki-brain (перед завершением): ' + msgs.join(' | ') + '\n');
    process.exit(2);
  }
  process.exit(0);
}

/** SessionStart: одна строка статуса в контекст. Никогда не блокирует. */
function hookSession() {
  try {
    const a = analyze();
    let edges = 0;
    for (const s of a.outbound.values()) edges += s.size;
    const flags = [];
    if (a.orphans.length) flags.push(`сирот: ${a.orphans.length}`);
    if (a.broken.length) flags.push(`битых ссылок: ${a.broken.length}`);
    if (a.memProblems.unindexed.length) flags.push(`память не в индексе: ${a.memProblems.unindexed.length}`);
    const tail = flags.length ? ` ⚠️ ${flags.join(', ')} (см. node scripts/wiki-brain.mjs)` : ' ✅ чисто';
    process.stdout.write(`🧠 Wiki-brain: ${a.wikiFiles.length} статей, ${edges} связей.${tail}\n`);
  } catch { /* статус не критичен — молчим при ошибке */ }
  process.exit(0);
}

// =============================================================================
//  ВХОД
// =============================================================================
const arg = process.argv[2] || '';
if (arg === 'hook-postedit') hookPostEdit();
else if (arg === 'hook-stop') hookStop();
else if (arg === 'hook-session') hookSession();
else {
  const a = analyze();
  if (process.argv.includes('--graph')) writeGraph(a);
  if (process.argv.includes('--json')) {
    let edges = 0; for (const s of a.outbound.values()) edges += s.size;
    console.log(JSON.stringify({
      stats: { nodes: a.wikiFiles.length, edges, orphans: a.orphans.length, broken: a.broken.length },
      orphans: a.orphans, deadends: a.deadends, broken: a.broken, memory: a.memProblems,
    }, null, 2));
  } else {
    console.log(report(a));
  }
  const hasProblems = a.orphans.length || a.broken.length ||
    a.memProblems.unindexed.length || a.memProblems.stalePointers.length || a.memProblems.brokenPaths.length;
  process.exit(hasProblems ? 1 : 0);
}
