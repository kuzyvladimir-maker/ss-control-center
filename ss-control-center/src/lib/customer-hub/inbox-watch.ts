/**
 * Inbox watch — no buyer message may sit unanswered without the owner knowing.
 *
 * Owner, topic 42, 2026-11-01: two Seller Central messages went Over SLA
 * (Michael 113-8615743-9544212, brenda 114-2471869-1927461) while the hub
 * showed nothing:
 *  - brenda: the confirmation sweep matched our 26.10 reply confirmation to her
 *    31.10 follow-up (same order, 7-day window, no time check) and closed the
 *    case 3 s after its card was built.
 *  - Michael: the card was posted once (30.10) and then dropped out of
 *    cs_cards_pending, which lists unposted cards only; nothing re-surfaced it
 *    before the 24 h deadline.
 *
 * This module:
 *  1. replyAnswers() — a reply counts only if it was sent AFTER the message;
 *  2. urgency per open case (overdue / < 6 h / card without decision > 2 h);
 *  3. reconcileInbox() — every open message must have a live card or task,
 *     otherwise the card is built now (cs_case_process with force_card);
 *  4. alerts to topic 42 as alert cards (cardJson.kind = "alert", no
 *     buttons) that Jackie posts exactly like reply cards;
 *  5. INBOX_SCAN tasks: the account VPS reads the Seller Central inbox
 *     (Response Needed) read-only; the hub reopens anything it closed that
 *     Seller Central still shows as Response Needed;
 *  6. inboxStatus() — the one-call metric for cs_inbox_status.
 */
import { prisma } from "@/lib/prisma";
import { processCase } from "./cs-pipeline";
import { validateInboxScan, urgencyOf, type InboxItem, type Urgency, type UrgencyLevel } from "./inbox-rules";
export { closeAnsweredByReply } from "./answered";
export * from "./inbox-rules";

export const LOOKBACK_DAYS = 7;
export const ALERT_REPEAT_H = 3;
/** A LOOKUP task nobody picked up within this time no longer blocks the card. */
export const LOOKUP_STALE_MIN = 30;
/** Messages synced less than this ago are still being processed by the sync. */
const FRESH_SYNC_MIN = 10;
/** Seller Central inbox scan cadence and how long a scan counts as current. */
export const INBOX_SCAN_EVERY_MIN = 30;
export const INBOX_SCAN_FRESH_MIN = 60;
const INBOX_SCAN_FAILED_COOLDOWN_H = 6;

export const LIVE_CARD = ["PENDING", "PUBLISHED", "WRONG", "REWORK", "APPROVED"];
const LIVE_TASK = ["QUEUED", "CLAIMED"];
const OPEN_STATUS = ["NEW", "ANALYZED"];
/** Alert cards are not tied to a buyer message; they share this marker. */
export const ALERT_CARD_MESSAGE_ID = "cs-alert";
/** Seller Central inbox scans are not tied to a buyer message either. */
export const INBOX_SCAN_MESSAGE_ID = "cs-inbox-scan";
/** Amazon stores covered by the watch (owner: all five accounts). */
export { ACTIVE_CS_STORES as WATCHED_STORES } from "./config";
import { ACTIVE_CS_STORES as WATCHED_STORES } from "./config";
/** Project Telegram group (topic 42 lives there) — for message links only. */
const TG_GROUP_LINK_ID = "3924739153";

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export function telegramLink(telegramMessageId: string | null | undefined): string | null {
  return telegramMessageId ? `https://t.me/c/${TG_GROUP_LINK_ID}/${telegramMessageId}` : null;
}

function etTime(d: Date): string {
  return d.toLocaleString("ru-RU", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Open cases (DB)
// ---------------------------------------------------------------------------

export interface OpenCase {
  key: string;
  storeIndex: number;
  storeName: string;
  orderId: string | null;
  buyer: string | null;
  /** Newest unanswered message — the one the card is built for. */
  messageId: string;
  messageIds: string[];
  receivedAt: Date;
  newestCreatedAt: Date;
  card: { id: string; status: string; version: number; createdAt: Date; publishedAt: Date | null; telegramMessageId: string | null } | null;
  sendTask: { id: string; status: string; createdAt: Date } | null;
  lookupTask: { id: string; status: string; createdAt: Date } | null;
  covered: boolean;
  urgency: Urgency;
  /** Seller Central inbox (latest fresh VPS scan) lists this order as Response Needed. */
  inbox: "response_needed" | "not_listed" | "unknown";
}

async function loadOpenCases(now: Date, inboxByStore: Map<number, InboxScanView>): Promise<OpenCase[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const msgs = await prisma.buyerMessage.findMany({
    where: {
      direction: "incoming",
      channel: "Amazon",
      status: { in: OPEN_STATUS },
      responseSentAt: null,
      storeIndex: { in: WATCHED_STORES },
      OR: [{ receivedAt: { gte: since } }, { receivedAt: null, createdAt: { gte: since } }],
    },
    select: {
      id: true,
      storeIndex: true,
      storeName: true,
      customerName: true,
      amazonOrderId: true,
      receivedAt: true,
      createdAt: true,
    },
  });
  if (msgs.length === 0) return [];
  const ids = msgs.map((m) => m.id);
  const [cards, tasks] = await Promise.all([
    prisma.csCard.findMany({
      where: { buyerMessageId: { in: ids }, status: { in: LIVE_CARD } },
      orderBy: { version: "desc" },
    }),
    prisma.csTask.findMany({
      where: { buyerMessageId: { in: ids }, status: { in: LIVE_TASK } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const groups = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const key = `${m.storeIndex}:${m.amazonOrderId || m.id}`;
    groups.set(key, [...(groups.get(key) || []), m]);
  }

  const out: OpenCase[] = [];
  for (const [key, list] of groups) {
    const at = (m: (typeof msgs)[number]) => (m.receivedAt || m.createdAt).getTime();
    list.sort((a, b) => at(a) - at(b));
    const oldest = list[0];
    const newest = list[list.length - 1];
    const mids = new Set(list.map((m) => m.id));
    const card = cards.find((c) => mids.has(c.buyerMessageId)) || null;
    const sendTask = tasks.find((t) => mids.has(t.buyerMessageId) && t.kind === "SEND") || null;
    const lookupTask = tasks.find((t) => mids.has(t.buyerMessageId) && t.kind === "LOOKUP") || null;
    const lookupLive =
      Boolean(lookupTask) && now.getTime() - (lookupTask as { createdAt: Date }).createdAt.getTime() < LOOKUP_STALE_MIN * 60_000;
    const covered = Boolean(card) || Boolean(sendTask) || lookupLive;
    const scan = inboxByStore.get(newest.storeIndex);
    const inbox: OpenCase["inbox"] =
      scan && scan.fresh && newest.amazonOrderId
        ? scan.items.some((i) => i.orderId === newest.amazonOrderId)
          ? "response_needed"
          : "not_listed"
        : "unknown";
    out.push({
      key,
      storeIndex: newest.storeIndex,
      storeName: newest.storeName,
      orderId: newest.amazonOrderId,
      buyer: newest.customerName,
      messageId: newest.id,
      messageIds: list.map((m) => m.id),
      receivedAt: oldest.receivedAt || oldest.createdAt,
      newestCreatedAt: newest.createdAt,
      card: card
        ? {
            id: card.id,
            status: card.status,
            version: card.version,
            createdAt: card.createdAt,
            publishedAt: card.publishedAt,
            telegramMessageId: card.telegramMessageId,
          }
        : null,
      sendTask: sendTask ? { id: sendTask.id, status: sendTask.status, createdAt: sendTask.createdAt } : null,
      lookupTask: lookupTask ? { id: lookupTask.id, status: lookupTask.status, createdAt: lookupTask.createdAt } : null,
      covered,
      urgency: urgencyOf({ receivedAt: oldest.receivedAt || oldest.createdAt, now, card, sendTask, covered }),
      inbox,
    });
  }
  out.sort((a, b) => a.urgency.hoursLeft - b.urgency.hoursLeft);
  return out;
}

// ---------------------------------------------------------------------------
// Seller Central inbox scans (INBOX_SCAN tasks for the account VPS)
// ---------------------------------------------------------------------------

export interface InboxScanView {
  storeIndex: number;
  /** "fresh" scan within INBOX_SCAN_FRESH_MIN, or the reason there is none. */
  state: "fresh" | "stale" | "queued" | "failed" | "never";
  fresh: boolean;
  scannedAt: string | null;
  items: InboxItem[];
  error: string | null;
}

const INBOX_SCAN_INSTRUCTIONS_RU =
  "ТОЛЬКО ЧТЕНИЕ. На VPS этого аккаунта открыть Seller Central → Buyer Messages → фильтр «Response needed» (включая Over SLA). " +
  "Ничего не отправлять, не нажимать «No response needed», не открывать вложения покупателя. " +
  "Для каждого письма в списке вернуть: orderId, buyerName, subject, receivedAt (как показано), overSla (true/false), text (текст последнего сообщения покупателя, если виден). " +
  "Также прочитать Resolved. Все страницы обоих фильтров; сверить аккаунт Salutem Solutions. " +
  "Отчёт: cs_task_complete outcome=DONE result={storeIndex:1,accountName:'Salutem Solutions',complete:true,scannedAt:ISO,items:[…],resolved:[…]}. Неполное чтение/нет доступа = FAILED.";

async function latestInboxScans(now: Date): Promise<Map<number, InboxScanView>> {
  const rows = await prisma.csTask.findMany({
    where: { kind: "INBOX_SCAN", createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<number, InboxScanView>();
  for (const s of WATCHED_STORES) {
    const mine = rows.filter((r) => r.storeIndex === s);
    const done = mine.find((r) => r.status === "DONE" && r.completedAt);
    const latest = mine[0];
    if (done) {
      let parsed;
      try {
        // Validate shape against completion time; freshness uses observation time below.
        parsed = validateInboxScan(JSON.parse(done.resultJson || "{}"), done.completedAt as Date);
      } catch {
        map.set(s, { storeIndex: s, state: "failed", fresh: false, scannedAt: null, items: [], error: "Invalid/incomplete scan" });
        continue;
      }
      const items = parsed.items;
      const fresh = now.getTime() - parsed.scannedAt.getTime() < INBOX_SCAN_FRESH_MIN * 60_000;
      map.set(s, {
        storeIndex: s,
        state: fresh ? "fresh" : "stale",
        fresh,
        scannedAt: parsed.scannedAt.toISOString(),
        items,
        error: null,
      });
    } else {
      map.set(s, {
        storeIndex: s,
        state: !latest ? "never" : LIVE_TASK.includes(latest.status) ? "queued" : "failed",
        fresh: false,
        scannedAt: null,
        items: [],
        error: latest?.error ?? null,
      });
    }
  }
  return map;
}

/** One INBOX_SCAN per store at a time, every INBOX_SCAN_EVERY_MIN. */
async function queueInboxScans(now: Date): Promise<number> {
  let queued = 0;
  const slot = Math.floor(now.getTime() / (INBOX_SCAN_EVERY_MIN * 60_000));
  for (const s of WATCHED_STORES) {
    const last = await prisma.csTask.findFirst({
      where: { kind: "INBOX_SCAN", storeIndex: s },
      orderBy: { createdAt: "desc" },
    });
    if (last && LIVE_TASK.includes(last.status)) continue;
    if (last && now.getTime() - last.createdAt.getTime() < INBOX_SCAN_EVERY_MIN * 60_000) continue;
    if (
      last &&
      last.status === "FAILED" &&
      now.getTime() - last.createdAt.getTime() < INBOX_SCAN_FAILED_COOLDOWN_H * 3600_000
    )
      continue;
    const idempotencyKey = `inbox:${s}:${slot}`;
    const exists = await prisma.csTask.findUnique({ where: { idempotencyKey } });
    if (exists) continue;
    await prisma.csTask.create({
      data: {
        kind: "INBOX_SCAN",
        storeIndex: s,
        buyerMessageId: INBOX_SCAN_MESSAGE_ID,
        payloadJson: JSON.stringify({ instructionsRu: INBOX_SCAN_INSTRUCTIONS_RU }),
        idempotencyKey,
      },
    });
    queued++;
  }
  return queued;
}

/**
 * Seller Central is the truth. For every Response Needed item of a fresh
 * scan: a hub case already open → fine; the hub closed it by inference
 * (confirmation email / our reply in the Gmail thread) → reopen; no message
 * in the hub at all → create it from the scan so a card gets built. A case
 * the VPS agent itself reported as SENT is never reopened (one send per
 * message) — it goes to the owner as an inbox mismatch.
 */
async function applyInboxScans(
  now: Date,
  scans: Map<number, InboxScanView>
): Promise<{ reopened: string[]; created: string[]; mismatches: string[] }> {
  const reopened: string[] = [];
  const created: string[] = [];
  const mismatches: string[] = [];
  for (const scan of scans.values()) {
    if (!scan.fresh || !scan.scannedAt) continue;
    const scannedAt = new Date(scan.scannedAt);
    const needed = scan.items.map((i) => i.orderId as string);
    const absent = await prisma.buyerMessage.findMany({ where: {
      channel: "Amazon", storeIndex: scan.storeIndex, direction: "incoming",
      status: { in: OPEN_STATUS }, responseSentAt: null,
      createdAt: { lte: scannedAt }, updatedAt: { lte: scannedAt },
      amazonOrderId: { not: null, notIn: needed },
      OR: [{ receivedAt: { lte: scannedAt } }, { receivedAt: null }],
    } });
    for (const m of absent) {
      // Never interfere with a send already claimed by the account agent.
      if (await prisma.csTask.findFirst({ where: { buyerMessageId: m.id, kind: "SEND", status: "CLAIMED" } })) continue;
      await prisma.$transaction(async (tx) => {
        const closed = await tx.buyerMessage.updateMany({ where: { id: m.id, updatedAt: m.updatedAt, responseSentAt: null }, data: {
          status: "RESOLVED", caseStage: "CLOSED_IN_AMAZON",
          resolution: `Закрыто в Amazon; source=SELLER_CENTRAL_INBOX_SCAN; scannedAt=${scan.scannedAt}`,
        } });
        if (!closed.count) return;
        await tx.csCard.updateMany({ where: { buyerMessageId: m.id, status: { in: LIVE_CARD } }, data: { status: "SUPERSEDED" } });
        await tx.csTask.updateMany({ where: { buyerMessageId: m.id, status: "QUEUED" }, data: { status: "CANCELLED", error: `Closed in Amazon by scan ${scan.scannedAt}` } });
      });
    }
    for (const item of scan.items) {
      if (!item.orderId) continue;
      const msgs = await prisma.buyerMessage.findMany({
        where: { storeIndex: scan.storeIndex, amazonOrderId: item.orderId, direction: "incoming" },
        orderBy: { createdAt: "desc" },
      });
      if (msgs.some((m) => OPEN_STATUS.includes(m.status) && !m.responseSentAt)) continue;
      const newest = msgs[0];
      if (newest) {
        const closedAt = newest.responseSentAt || newest.updatedAt;
        if (closedAt.getTime() > scannedAt.getTime()) continue; // closed after the scan — newer truth
        if (newest.responseSentVia === "VPS_AGENT") {
          mismatches.push(`${scan.storeIndex}:${item.orderId}`);
          continue;
        }
        await prisma.buyerMessage.update({
          where: { id: newest.id },
          data: {
            status: "ANALYZED",
            responseSentAt: null,
            responseSentVia: null,
            caseStage: null,
            resolution: `reopened: Seller Central inbox shows Response Needed (scan ${scan.scannedAt})`,
          },
        });
        reopened.push(newest.id);
        continue;
      }
      const store = await prisma.store.findFirst({ where: { channel: "Amazon", storeIndex: scan.storeIndex } });
      const parsedAt = item.receivedAt ? new Date(item.receivedAt) : null;
      const m = await prisma.buyerMessage.create({
        data: {
          channel: "Amazon",
          source: "vps_inbox",
          storeIndex: scan.storeIndex,
          storeName: store?.name || `Store ${scan.storeIndex}`,
          customerName: item.buyerName,
          amazonOrderId: item.orderId,
          receivedAt: parsedAt && !Number.isNaN(parsedAt.getTime()) ? parsedAt : now,
          direction: "incoming",
          customerMessage: item.text || item.subject || "(the VPS inbox scan did not capture the message text)",
          status: "NEW",
        },
      });
      created.push(m.id);
    }
  }
  return { reopened, created, mismatches };
}

// ---------------------------------------------------------------------------
// Alerts → topic 42 (alert cards posted by Jackie)
// ---------------------------------------------------------------------------

const LEVEL_RU: Record<UrgencyLevel, string> = {
  overdue: "ПРОСРОЧЕНО",
  due_soon: "меньше 6 ч до срока",
  no_card: "нет карточки",
  send_stuck: "одобрено, но не отправлено",
  card_stale: "карточка без решения больше 2 ч",
  ok: "ok",
};

function cardStateRu(c: OpenCase): string {
  if (c.sendTask) return `ответ одобрен, задача отправки ${c.sendTask.status} с ${etTime(c.sendTask.createdAt)} ET`;
  if (!c.card) return c.lookupTask ? "ждём VPS-поиск данных" : "карточки нет — собираю";
  const link = telegramLink(c.card.telegramMessageId);
  if (c.card.status === "PUBLISHED")
    return `карточка v${c.card.version} в топике с ${c.card.publishedAt ? etTime(c.card.publishedAt) : "?"} ET, решения нет${link ? ` — ${link}` : ""}`;
  if (c.card.status === "PENDING") return `карточка v${c.card.version} собрана ${etTime(c.card.createdAt)} ET, ещё не опубликована`;
  return `карточка v${c.card.version}: ${c.card.status}`;
}

function alertLine(c: OpenCase, level: UrgencyLevel): string {
  const due = new Date(c.urgency.deadline);
  const when = c.urgency.hoursLeft <= 0 ? `срок был ${etTime(due)} ET` : `срок ${etTime(due)} ET (~${Math.max(1, Math.round(c.urgency.hoursLeft))} ч)`;
  const inbox = c.inbox === "not_listed" ? " · в инбоксе Seller Central уже не Response Needed" : "";
  return `- **${LEVEL_RU[level]}** · ${c.storeName} · ${c.orderId || "без номера заказа"} · ${c.buyer || "покупатель"} · ${when} · ${cardStateRu(c)}${inbox}`;
}

export function alertKey(c: OpenCase, level: UrgencyLevel): string {
  return `${c.key}:${level}`;
}

async function recentAlertKeys(now: Date): Promise<Set<string>> {
  const rows = await prisma.csCard.findMany({
    where: { buyerMessageId: ALERT_CARD_MESSAGE_ID, createdAt: { gte: new Date(now.getTime() - ALERT_REPEAT_H * 3600_000) } },
    select: { cardJson: true },
  });
  const keys = new Set<string>();
  for (const r of rows) {
    try {
      for (const k of (JSON.parse(r.cardJson).keys as string[]) || []) keys.add(k);
    } catch {
      /* ignore */
    }
  }
  return keys;
}

async function postAlert(
  now: Date,
  cases: OpenCase[],
  extraLines: string[],
  scans: Map<number, InboxScanView>
): Promise<{ cardId: string | null; keys: string[] }> {
  const seen = await recentAlertKeys(now);
  const lines: string[] = [];
  const keys: string[] = [];
  for (const c of cases) {
    const level = c.urgency.flags.find((f) => f !== "ok");
    if (!level) continue;
    const key = alertKey(c, level);
    if (seen.has(key)) continue;
    keys.push(key);
    lines.push(alertLine(c, level));
  }
  const extraKeys = extraLines.map((l) => `extra:${l}`).filter((k) => !seen.has(k));
  const extras = extraLines.filter((l) => !seen.has(`extra:${l}`));
  if (lines.length === 0 && extras.length === 0) return { cardId: null, keys: [] };

  const overdue = cases.filter((c) => c.urgency.flags.includes("overdue")).length;
  const scanRu = [...scans.values()]
    .map((s) =>
      s.state === "fresh"
        ? `магазин ${s.storeIndex}: Response Needed ${s.items.length}${s.items.some((i) => i.overSla) ? ` (Over SLA ${s.items.filter((i) => i.overSla).length})` : ""}, проверено ${etTime(new Date(s.scannedAt as string))} ET`
        : `магазин ${s.storeIndex}: инбокс не проверен (${s.state === "queued" ? "задача VPS ждёт агента" : s.state === "failed" ? `агент не смог: ${s.error || "?"}` : s.state === "stale" ? "последняя проверка устарела" : "сканов ещё не было"})`
    )
    .join("\n");
  const textRu = [
    "# Тревога: письма покупателей без ответа",
    "",
    ...lines,
    ...extras.map((l) => `- ${l}`),
    "",
    `Открыто в хабе: ${cases.length}, просрочено: ${overdue}.`,
    "",
    "Инбокс Seller Central (VPS, только чтение):",
    scanRu,
  ].join("\n");

  const card = await prisma.csCard.create({ data: { buyerMessageId: ALERT_CARD_MESSAGE_ID, cardJson: "{}" } });
  const worst = cases.find((c) => keys.some((k) => k.startsWith(`${c.key}:`)))?.urgency.level ?? "ok";
  await prisma.csCard.update({
    where: { id: card.id },
    data: {
      cardJson: JSON.stringify({
        cardId: card.id,
        kind: "alert",
        version: 1,
        urgency: worst,
        textRu,
        buttons: [],
        keys: [...keys, ...extraKeys],
      }),
    },
  });
  return { cardId: card.id, keys };
}

// ---------------------------------------------------------------------------
// Reconcile (cron) + status (cs_inbox_status)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  open: number;
  built: { messageId: string; stage: string }[];
  deferred: number;
  reopened: string[];
  createdFromInbox: string[];
  mismatches: string[];
  scansQueued: number;
  alertCardId: string | null;
  errors: string[];
}

export async function reconcileInbox(
  opts: { now?: Date; budgetMs?: number; dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const errors: string[] = [];
  const scansQueued = opts.dryRun ? 0 : await queueInboxScans(now);
  const scans = await latestInboxScans(now);
  const applied = opts.dryRun
    ? { reopened: [], created: [], mismatches: [] }
    : await applyInboxScans(now, scans);

  let cases = await loadOpenCases(now, scans);
  const built: ReconcileResult["built"] = [];
  let deferred = 0;
  const fromInbox = new Set([...applied.reopened, ...applied.created]);
  for (const c of cases) {
    if (c.covered) continue;
    const syncing =
      now.getTime() - c.newestCreatedAt.getTime() < FRESH_SYNC_MIN * 60_000 && !c.messageIds.some((id) => fromInbox.has(id));
    if (syncing) continue;
    if (opts.dryRun) {
      built.push({ messageId: c.messageId, stage: "WOULD_BUILD" });
      continue;
    }
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) {
      deferred++;
      continue;
    }
    try {
      if (c.lookupTask) {
        await prisma.csTask.updateMany({
          where: { id: c.lookupTask.id, status: "QUEUED" },
          data: { status: "CANCELLED", error: `no VPS agent within ${LOOKUP_STALE_MIN} min — card built without it (inbox watch)` },
        });
      }
      const r = await processCase(c.messageId, { forceCard: true });
      built.push({ messageId: c.messageId, stage: r.stage });
    } catch (e) {
      errors.push(`${c.messageId}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  if (built.length && !opts.dryRun) cases = await loadOpenCases(now, scans);

  const extra = applied.mismatches.map(
    (k) => `Seller Central показывает Response Needed по ${k.split(":")[1]} (магазин ${k.split(":")[0]}), а по хабу наш ответ уже отправлен агентом — проверить вручную, повторно не отправляю`
  );
  const alert = opts.dryRun ? { cardId: null } : await postAlert(now, cases, extra, scans);

  return {
    open: cases.length,
    built,
    deferred,
    reopened: applied.reopened,
    createdFromInbox: applied.created,
    mismatches: applied.mismatches,
    scansQueued,
    alertCardId: alert.cardId,
    errors,
  };
}

export async function inboxStatus(now: Date = new Date()) {
  const scans = await latestInboxScans(now);
  const allCases = await loadOpenCases(now, scans);
  const cases = allCases.filter((c) => c.inbox === "response_needed");
  const confirmed = await openThreads(now);
  const count = (l: UrgencyLevel) => cases.filter((c) => c.urgency.flags.includes(l)).length;
  const awaiting = await prisma.csCard.findMany({
    where: { status: "PUBLISHED", NOT: { buyerMessageId: ALERT_CARD_MESSAGE_ID } },
    select: { id: true, buyerMessageId: true, version: true, publishedAt: true, telegramMessageId: true },
  });
  return {
    generatedAt: now.toISOString(),
    stale: confirmed.stale,
    lastScanAt: confirmed.lastScanAt,
    totals: {
      unanswered: confirmed.stale ? null : confirmed.threads.length,
      overdue: count("overdue"),
      dueUnder6h: count("due_soon"),
      noCard: count("no_card"),
      cardWithoutDecision2h: count("card_stale"),
      sendStuck: count("send_stuck"),
      cardsAwaitingOwner: awaiting.filter((c) => cases.some((x) => x.messageIds.includes(c.buyerMessageId))).length,
    },
    stores: WATCHED_STORES.map((s) => {
      const mine = cases.filter((c) => c.storeIndex === s);
      const scan = scans.get(s) as InboxScanView;
      return {
        storeIndex: s,
        unanswered: scan.fresh ? scan.items.length : null,
        overdue: mine.filter((c) => c.urgency.flags.includes("overdue")).length,
        sellerCentralInbox: {
          state: scan.state,
          scannedAt: scan.scannedAt,
          responseNeeded: scan.fresh ? scan.items.length : null,
          overSla: scan.fresh ? scan.items.filter((i) => i.overSla).length : null,
          error: scan.error,
        },
      };
    }),
    cases: cases.map((c) => ({
      orderId: c.orderId,
      buyer: c.buyer,
      storeIndex: c.storeIndex,
      messageId: c.messageId,
      receivedAt: c.receivedAt.toISOString(),
      deadline: c.urgency.deadline,
      hoursLeft: c.urgency.hoursLeft,
      urgency: c.urgency.level,
      flags: c.urgency.flags,
      inbox: c.inbox,
      card: c.card
        ? { id: c.card.id, status: c.card.status, version: c.card.version, telegramLink: telegramLink(c.card.telegramMessageId) }
        : null,
      sendTask: c.sendTask ? { id: c.sendTask.id, status: c.sendTask.status } : null,
    })),
  };
}

/** urgency for a card in cs_cards_pending (reply cards only). */
export async function cardUrgency(
  card: { buyerMessageId: string; status: string; createdAt: Date },
  now: Date = new Date()
): Promise<Urgency | null> {
  if (card.buyerMessageId === ALERT_CARD_MESSAGE_ID) return null;
  const m = await prisma.buyerMessage.findUnique({
    where: { id: card.buyerMessageId },
    select: { receivedAt: true, createdAt: true, amazonOrderId: true, storeIndex: true },
  });
  if (!m) return null;
  // Amazon's clock starts at the oldest unanswered message of the order.
  const oldest = m.amazonOrderId
    ? await prisma.buyerMessage.findFirst({
        where: {
          storeIndex: m.storeIndex,
          amazonOrderId: m.amazonOrderId,
          direction: "incoming",
          status: { in: OPEN_STATUS },
          responseSentAt: null,
        },
        orderBy: { receivedAt: "asc" },
        select: { receivedAt: true, createdAt: true },
      })
    : null;
  const receivedAt = oldest?.receivedAt || oldest?.createdAt || m.receivedAt || m.createdAt;
  return urgencyOf({ receivedAt, now, card, covered: true });
}

/**
 * Hub must not close a case as "answered in Seller Central" while a scan taken
 * after that reply still lists the order as Response Needed.
 */
export async function inboxStillNeedsReply(storeIndex: number, orderId: string, replySentAt: Date): Promise<boolean> {
  const scans = await latestInboxScans(new Date());
  const s = scans.get(storeIndex);
  if (!s || !s.fresh || !s.scannedAt) return false;
  return new Date(s.scannedAt).getTime() > replySentAt.getTime() && s.items.some((i) => i.orderId === orderId);
}

/** Only Seller Central observations determine membership; never infer from hub rows. */
export async function openThreads(now = new Date()) {
  const scans = await latestInboxScans(now);
  const scan = scans.get(1)!;
  const threads = await Promise.all(scan.items.map(async (item) => {
    const messages = await prisma.buyerMessage.findMany({ where: { storeIndex: 1, amazonOrderId: item.orderId, direction: "incoming" }, orderBy: { receivedAt: "desc" } });
    const card = await prisma.csCard.findFirst({ where: { buyerMessageId: { in: messages.map((m) => m.id) }, NOT: { buyerMessageId: ALERT_CARD_MESSAGE_ID } }, orderBy: { createdAt: "desc" } });
    const received = item.receivedAt ? new Date(item.receivedAt) : messages[0]?.receivedAt;
    return { order: item.orderId, buyer: item.buyerName, storeIndex: 1,
      deadline: received && Number.isFinite(received.getTime()) ? new Date(received.getTime() + 86400_000).toISOString() : null,
      overSla: item.overSla, cardStatus: card?.status ?? null,
      telegramLink: telegramLink(card?.telegramMessageId), lastScanAt: scan.scannedAt, stale: !scan.fresh };
  }));
  return { storeIndex: 1, lastScanAt: scan.scannedAt, stale: !scan.fresh, scanState: scan.state, threads };
}
