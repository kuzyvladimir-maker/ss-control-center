#!/usr/bin/env node
/**
 * release-pins — машинная генерация и сверка пинов релизов.
 *
 * ЗАЧЕМ
 * -----
 * До 2026-07-29 хеши релизов переписывались в документы руками: 231 SHA-256 в
 * прозе по docs/wiki/. Следствие: AGENTS.md пинил Listing Integrity на
 * 5af7bc87…/b3961fca…, тогда как реальный манифест v33 на диске давал
 * cf313774…398cb. Агент, исполнявший AGENTS.md буквально, был обязан отказаться
 * от единственной рабочей команды — и не мог узнать правду, не нарушив правило.
 *
 * Теперь источник истины — содержимое диска. Документы сверяются с ним.
 *
 *   node scripts/release-pins.mjs generate   # пересобрать release-pins.json
 *   node scripts/release-pins.mjs verify     # сверить документы с диском
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const REPO = '/Users/vladimirkuznetsov/SS Command Center';
const ARTIFACTS = join(REPO, 'release-artifacts');
const PINS = join(REPO, 'release-pins.json');
const WIKI = join(REPO, 'docs', 'wiki');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Собираем пины из того, что реально лежит на диске. */
function collect() {
  if (!existsSync(ARTIFACTS)) return {};
  const out = {};
  for (const name of readdirSync(ARTIFACTS)) {
    const dir = join(ARTIFACTS, name);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const manifest = join(dir, 'release-manifest.json');
    if (!existsSync(manifest)) continue;

    const entry = { release: name, manifestSha256: sha256(manifest) };

    // Заявленный рядом .sha256 — сверяем, не разошёлся ли он с содержимым
    const claimFile = join(dir, 'release-manifest.sha256');
    if (existsSync(claimFile)) {
      const claimed = readFileSync(claimFile, 'utf8').trim().split(/\s+/)[0];
      entry.claimedSha256 = claimed;
      entry.claimMatches = claimed === entry.manifestSha256;
    }

    // release ID, если движок его записал
    try {
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      for (const k of ['releaseId', 'release_id', 'releaseIdSha256']) {
        if (m && typeof m[k] === 'string') { entry.releaseId = m[k]; break; }
      }
    } catch { /* манифест не JSON — не критично */ }

    out[name] = entry;
  }
  return out;
}

function generate() {
  const pins = collect();
  const doc = {
    _comment: 'СГЕНЕРИРОВАНО scripts/release-pins.mjs — не редактировать руками. Источник истины: содержимое release-artifacts/ на диске.',
    generatedFrom: 'release-artifacts/',
    releases: pins,
  };
  writeFileSync(PINS, JSON.stringify(doc, null, 2) + '\n');
  const n = Object.keys(pins).length;
  console.log(`✅ release-pins.json пересобран: ${n} релиз(ов)`);
  for (const [k, v] of Object.entries(pins)) {
    const flag = v.claimMatches === false ? '  ⚠️ заявленный .sha256 НЕ совпадает с содержимым' : '';
    console.log(`   ${k}\n     manifest ${v.manifestSha256.slice(0, 16)}…${flag}`);
  }
  return pins;
}

/** Ищем в документах хеши, которых нет на диске. */
function verify() {
  const pins = collect();
  if (!Object.keys(pins).length) {
    console.log('⚠️  release-artifacts/ пуст — сверять не с чем');
    return 0;
  }
  const known = new Set();
  for (const v of Object.values(pins)) {
    if (v.manifestSha256) known.add(v.manifestSha256);
    if (v.claimedSha256) known.add(v.claimedSha256);
    if (v.releaseId) known.add(v.releaseId);
  }

  const files = [join(REPO, 'AGENTS.md'), join(REPO, 'CLAUDE.md')];
  if (existsSync(WIKI)) {
    for (const f of readdirSync(WIKI)) if (f.endsWith('.md')) files.push(join(WIKI, f));
  }

  let stale = 0;
  const SHA_RE = /\b([a-f0-9]{64})\b/g;
  for (const f of files) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const found = new Set(text.match(SHA_RE) || []);
    for (const h of found) {
      if (!known.has(h)) {
        // Хеш длиной 64, которого нет ни в одном релизе на диске
        if (stale === 0) console.log('⚠️  хеши в документах, отсутствующие на диске:');
        console.log(`   ${f.replace(REPO + '/', '')}: ${h.slice(0, 16)}…`);
        stale++;
      }
    }
  }
  if (!stale) { console.log('✅ verify: все полные SHA-256 в документах соответствуют дискам'); return 0; }
  console.log(`\n${stale} несоответствий. Правило: прав ДИСК, правится документ.`);
  return 1;
}

const cmd = process.argv[2];
if (cmd === 'generate') generate();
else if (cmd === 'verify') process.exitCode = verify();
else {
  console.log('release-pins — машинные пины релизов вместо прозаических\n');
  console.log('  generate   пересобрать release-pins.json из release-artifacts/');
  console.log('  verify     найти в документах хеши, которых нет на диске');
  process.exitCode = 1;
}
