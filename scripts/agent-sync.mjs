#!/usr/bin/env node
/**
 * agent-sync — координация параллельной работы Claude Code и Codex.
 *
 * ЗАЧЕМ ЭТО НУЖНО (история проблемы)
 * ----------------------------------
 * 2026-07: две параллельные сессии агентов работали в одном репозитории без
 * координации. Итог, измеренный по git-истории:
 *   - 44 % коммитов ушло в координационную доску внутри git (чистые накладные);
 *   - cron авто-сохранения закоммитил недописанный файл и заморозил
 *     прод-деплои на 5 дней (коммит cee52107);
 *   - локальная main разошлась с origin на 56/16 коммитов;
 *   - одновременные git-операции оставили 12 ГБ битых tmp_pack в .git;
 *   - 30 брошенных worktree заняли 150 ГБ и забили диск.
 *
 * ПРИНЦИПЫ
 * --------
 * 1. Состояние координации ЖИВЁТ ВНЕ GIT (~/.sscc-agent-sync). Ноль коммитов
 *    на саму координацию — именно это съело 44 % прошлой работы.
 * 2. Взаимоисключающая блокировка на любую git-операцию, меняющую историю.
 *    Два агента физически не могут коммитить одновременно.
 * 3. Каждый commit немедленно уезжает на origin. Работа не живёт только
 *    на локальном диске.
 * 4. Заявка на «полосу» (lane) — предупреждение, а не запрет. Агент видит,
 *    что другой уже правит эту область, и выбирает другую.
 *
 * КОМАНДЫ
 *   node scripts/agent-sync.mjs claim <lane> "<что делаю>"
 *   node scripts/agent-sync.mjs status
 *   node scripts/agent-sync.mjs sync "<msg>" <path> [path...]   # commit+rebase+push под локом
 *   node scripts/agent-sync.mjs release
 *   node scripts/agent-sync.mjs doctor
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.sscc-agent-sync');
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOCK_FILE = join(STATE_DIR, 'git.lock');
const REPO = '/Users/vladimirkuznetsov/SS Command Center';

/** Кто мы: Claude Code или Codex — определяем по переменным окружения. */
function whoAmI() {
  if (process.env.CLAUDE_AGENT || process.env.CLAUDECODE) return 'claude';
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex';
  return process.env.AGENT_NAME || 'unknown';
}

const CLAIM_TTL_MS = 90 * 60 * 1000; // заявка живёт 90 минут — дольше любого разумного шага

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function loadState() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return { claims: [] };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { claims: [] }; }
}

function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Убираем протухшие заявки — агент мог упасть, не освободив полосу. */
function liveClaims(state, nowMs) {
  return (state.claims || []).filter((c) => nowMs - new Date(c.at).getTime() < CLAIM_TTL_MS);
}

/**
 * Эксклюзивная блокировка на git-операции.
 * Именно одновременные git-операции оставили 12 ГБ битых tmp_pack.
 */
function withGitLock(fn, { timeoutMs = 180000 } = {}) {
  mkdirSync(STATE_DIR, { recursive: true });
  const started = Date.now();
  let fd = null;
  while (Date.now() - started < timeoutMs) {
    try {
      fd = openSync(LOCK_FILE, 'wx'); // атомарно: падает, если файл уже есть
      writeFileSync(LOCK_FILE, JSON.stringify({ agent: whoAmI(), pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Снимаем зависший лок: процесс мёртв или лок старше 10 минут
      try {
        const held = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
        const ageMs = Date.now() - new Date(held.at).getTime();
        let alive = false;
        try { process.kill(held.pid, 0); alive = true; } catch { alive = false; }
        if (!alive || ageMs > 10 * 60 * 1000) {
          rmSync(LOCK_FILE, { force: true });
          continue;
        }
      } catch { rmSync(LOCK_FILE, { force: true }); continue; }
      execFileSync('sleep', ['2']);
    }
  }
  if (fd === null) throw new Error('AGENT_SYNC_LOCK_TIMEOUT: другой агент держит git-лок дольше 3 минут');
  try { closeSync(fd); return fn(); }
  finally { rmSync(LOCK_FILE, { force: true }); }
}

function cmdClaim(lane, note) {
  if (!lane) throw new Error('usage: claim <lane> "<note>"');
  const me = whoAmI();
  const now = Date.now();
  const state = loadState();
  const live = liveClaims(state, now);
  const conflict = live.find((c) => c.lane === lane && c.agent !== me);
  if (conflict) {
    console.log(`⚠️  ПОЛОСА ЗАНЯТА: "${lane}" уже держит ${conflict.agent} с ${conflict.at}`);
    console.log(`    Что делает: ${conflict.note}`);
    console.log(`    Возьми другую полосу или дождись освобождения. Параллельная правка тех же файлов = конфликт.`);
    process.exitCode = 2;
    return;
  }
  const others = live.filter((c) => !(c.lane === lane && c.agent === me));
  others.push({ agent: me, lane, note: note || '', at: new Date().toISOString(), pid: process.pid });
  saveState({ ...state, claims: others });
  console.log(`✅ Полоса "${lane}" закреплена за ${me}`);
}

function cmdStatus() {
  const state = loadState();
  const live = liveClaims(state, Date.now());
  console.log(`агент: ${whoAmI()}`);
  console.log(`ветка: ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
  let ahead = '0', behind = '0';
  try {
    git(['fetch', 'origin', '--quiet']);
    ahead = git(['rev-list', '--count', 'origin/main..HEAD']);
    behind = git(['rev-list', '--count', 'HEAD..origin/main']);
  } catch { /* оффлайн — не критично */ }
  console.log(`не отправлено на origin: ${ahead} | не забрано с origin: ${behind}`);
  console.log(`изменённых файлов: ${git(['status', '--porcelain']).split('\n').filter(Boolean).length}`);
  if (!live.length) { console.log('активных полос нет'); return; }
  console.log('активные полосы:');
  for (const c of live) console.log(`  [${c.agent}] ${c.lane} — ${c.note} (с ${c.at})`);
}

/**
 * Одна атомарная единица работы: add → commit → pull --rebase → push.
 *
 * ВАЖНО: пути указываются ЯВНО. `git add -A` здесь запрещён — Claude и Codex
 * делят одно рабочее дерево, и `add -A` закоммитил бы незаконченную работу
 * второго агента. Именно так cron авто-сохранения закоммитил недописанный файл
 * и заморозил прод-деплои на 5 дней (коммит cee52107, 18–23 июля 2026).
 */
function cmdSync(message, paths) {
  if (!message) throw new Error('usage: sync "<commit message>" <path> [path...]');
  if (!paths || !paths.length) {
    throw new Error(
      'НУЖНЫ ЯВНЫЕ ПУТИ: sync "<msg>" <path> [path...]\n' +
      '   `git add -A` запрещён — в общем рабочем дереве он заберёт чужую незаконченную работу.'
    );
  }
  return withGitLock(() => {
    git(['add', '--', ...paths]);
    const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (!staged.length) { console.log('нечего коммитить в указанных путях'); }
    else {
      console.log(`— коммичу ${staged.length} файл(ов):`);
      for (const f of staged.slice(0, 20)) console.log(`    ${f}`);
      try {
        execFileSync('git', ['commit', '-m', message], { cwd: REPO, stdio: 'inherit' });
      } catch { console.log('коммит не создан'); }
    }
    console.log('— забираю origin с rebase…');
    try { execFileSync('git', ['pull', '--rebase', 'origin', 'main'], { cwd: REPO, stdio: 'inherit' }); }
    catch {
      console.error('❌ REBASE CONFLICT. История НЕ отправлена.');
      console.error('   Разреши конфликт, затем: git rebase --continue && node scripts/agent-sync.mjs sync "<msg>"');
      console.error('   Прервать: git rebase --abort');
      process.exitCode = 1; return;
    }
    console.log('— отправляю на origin…');
    execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd: REPO, stdio: 'inherit' });
    console.log('✅ синхронизировано с origin/main');
  });
}

function cmdRelease() {
  const me = whoAmI();
  const state = loadState();
  const kept = liveClaims(state, Date.now()).filter((c) => c.agent !== me);
  saveState({ ...state, claims: kept });
  console.log(`✅ полосы агента ${me} освобождены`);
}

/** Проверка здоровья: то, что реально ломалось в июле. */
function cmdDoctor() {
  const problems = [];
  const warn = (m) => problems.push(m);

  const ahead = (() => { try { git(['fetch', 'origin', '--quiet']); return +git(['rev-list', '--count', 'origin/main..HEAD']); } catch { return -1; } })();
  if (ahead > 10) warn(`${ahead} коммитов не отправлены на origin — работа живёт только на этом диске`);

  const garbage = (() => { try { return git(['count-objects', '-v']).split('\n').find((l) => l.startsWith('size-garbage:')) || ''; } catch { return ''; } })();
  const gsize = +(garbage.split(':')[1] || 0);
  if (gsize > 1_000_000) warn(`в .git ${(gsize / 1024 / 1024).toFixed(1)} ГБ мусора — запусти: git prune-packed && git gc`);

  const wts = git(['worktree', 'list']).split('\n').filter(Boolean);
  if (wts.length > 3) warn(`${wts.length} worktree зарегистрировано — брошенные чекауты забивают диск (норма ≤3)`);

  try {
    const free = execFileSync('df', ['-k', '/'], { encoding: 'utf8' }).split('\n')[1].split(/\s+/)[3];
    const freeGb = +free / 1024 / 1024;
    if (freeGb < 25) warn(`на диске всего ${freeGb.toFixed(0)} ГБ свободно`);
  } catch { /* ignore */ }

  const live = liveClaims(loadState(), Date.now());
  if (live.length > 1) {
    const lanes = new Set(live.map((c) => c.lane));
    if (lanes.size < live.length) warn('две сессии заявили одну полосу — вероятен конфликт');
  }

  if (!problems.length) { console.log('✅ doctor: чисто'); return; }
  console.log('⚠️  doctor нашёл проблемы:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

const [, , cmd, ...rest] = process.argv;
try {
  switch (cmd) {
    case 'claim': cmdClaim(rest[0], rest.slice(1).join(' ')); break;
    case 'status': cmdStatus(); break;
    case 'sync': cmdSync(rest[0], rest.slice(1)); break;
    case 'release': cmdRelease(); break;
    case 'doctor': cmdDoctor(); break;
    default:
      console.log('agent-sync — координация Claude Code и Codex\n');
      console.log('  claim <lane> "<note>"   закрепить область работы за собой');
      console.log('  status                  кто что делает + расхождение с origin');
      console.log('  sync "<msg>" <path>...  commit+rebase+push под эксклюзивным локом (пути ЯВНЫЕ)');
      console.log('  release                 освободить свои полосы');
      console.log('  doctor                  проверка на проблемы июля 2026');
      process.exitCode = 1;
  }
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exitCode = 1;
}
