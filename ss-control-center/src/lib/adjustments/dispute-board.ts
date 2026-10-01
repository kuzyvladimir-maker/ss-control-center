/**
 * Дашборд споров по корректировкам доставки: сводка по аккаунтам, кейсы,
 * здоровье кронов.
 *
 * Источник правды один — ShippingAdjustment + AdjustmentDisputeEvent. Файлы
 * сервера (queue.csv, penalties.csv, credits.csv) сюда приходят только через
 * /api/adjustments/registry-sync и вторым реестром не являются.
 *
 * Аккаунты считаются строго раздельно: строки одного кабинета в сводку и
 * кейсы другого не попадают никогда.
 */
import { prisma } from "@/lib/prisma";
import { STORE_ORIGINS } from "@/lib/adjustments/submission-origin";

/** Аккаунты, по которым ведём споры, и дата отсечки базовой выборки. */
export const BOARD_ACCOUNTS: Array<{
  storeId: string;
  name: string;
  /** Последняя дата списаний базового пакета (~$4k), оспоренного 20.09–01.10 */
  cutoff: string;
}> = [
  { storeId: "store1", name: "Salutem Solutions", cutoff: "2026-09-11" },
  { storeId: "store3", name: "AMZ Commerce", cutoff: "2026-09-18" },
];

export const BOARD_STORE_IDS = BOARD_ACCOUNTS.map((a) => a.storeId);

/** Корзины статусов для дашборда. */
const WON = new Set(["REFUNDED", "PARTIAL"]);
const REJECTED = new Set(["REJECTED"]);
/** Наш ход: черновик не подан или Amazon ответил и ждёт нас. */
const IN_WORK = new Set(["DRAFT", "REPLIED"]);
/** Мяч у Amazon. */
const AWAITING = new Set(["FILED", "AWAITING", "ESCALATED"]);
/** Подано хоть раз — значит, «оспариваем». */
const FILED_ANY = new Set([
  "FILED",
  "AWAITING",
  "REPLIED",
  "ESCALATED",
  "REJECTED",
  "PARTIAL",
  "REFUNDED",
  "CLOSED",
]);

export const CASE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  FILED: "Открыт",
  AWAITING: "Ждём Amazon",
  REPLIED: "Ответ Amazon",
  ESCALATED: "Повторная проверка",
  WON: "Выигран",
  PARTIAL: "Выигран частично",
  REJECTED: "Отказ",
  CLOSED: "Закрыт",
};

/** Сколько дней ждём до следующей проверки после события. */
const FOLLOW_UP_DAYS: Record<string, { days: number; action: string }> = {
  DRAFT: { days: 0, action: "подать кейс" },
  REPLIED: { days: 1, action: "ответить Amazon" },
  FILED: { days: 3, action: "проверить ответ по кейсу" },
  AWAITING: { days: 5, action: "проверить письмо и кредит в Payments" },
  ESCALATED: { days: 3, action: "проверить итог повторной проверки" },
};

export interface Money {
  count: number;
  amount: number;
}

export interface AccountPeriod {
  charged: Money; // предъявлено
  disputed: Money; // оспариваем (подано хоть раз)
  won: Money; // отвоёвано: amount = подтверждённый кредит
  rejected: Money;
  inWork: Money; // черновик / наш ход
  awaiting: Money; // ждёт ответа Amazon
}

export interface AccountBoard {
  storeId: string;
  name: string;
  vps: string | null;
  cutoff: string;
  all: AccountPeriod;
  last30: AccountPeriod;
  sinceCutoff: {
    charged: Money;
    disputable: Money; // черновик заведён или уже в работе
    untouched: Money; // ещё ни одного события
  };
}

export interface BoardCase {
  key: string;
  caseId: string | null;
  storeId: string;
  account: string;
  status: string;
  statusLabel: string;
  rows: number;
  amount: number;
  recovered: number;
  rejectedAmount: number;
  carriers: string[];
  breakdown: Array<{ status: string; count: number }>;
  openedAt: string | null;
  lastEventAt: string | null;
  nextActionDate: string | null;
  nextAction: string | null;
}

export interface CronHealth {
  job: string;
  label: string;
  where: string;
  schedule: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  stale: boolean;
}

/** Расписание кронов, которые кормят модуль. Время — America/New_York, кроме Vercel. */
const CRON_JOBS: Array<{
  job: string;
  label: string;
  where: string;
  schedule: string;
  /** час и минута запуска, ET; Vercel-крон задан в UTC */
  at: Array<{ hour: number; minute: number; tz: "UTC" | "ET" }>;
}> = [
  {
    job: "adjustments-amazon",
    label: "Сбор списаний в базу",
    where: "Vercel",
    schedule: "ежедневно 08:30 UTC",
    at: [{ hour: 8, minute: 30, tz: "UTC" }],
  },
  {
    job: "penalty-monitor",
    label: "Детектор новых штрафов (SP-API v2024)",
    where: "сервер",
    schedule: "ежедневно 08:40 ET",
    at: [{ hour: 8, minute: 40, tz: "ET" }],
  },
  {
    job: "registry-sync",
    label: "Перенос реестра и кредитов в модуль",
    where: "сервер",
    schedule: "ежедневно 09:00, 13:00, 17:00 ET",
    at: [
      { hour: 9, minute: 0, tz: "ET" },
      { hour: 13, minute: 0, tz: "ET" },
      { hour: 17, minute: 0, tz: "ET" },
    ],
  },
];

/** Порог «крон не отработал сутки» — с запасом на дрейф запуска. */
const STALE_HOURS = 26;

function empty(): Money {
  return { count: 0, amount: 0 };
}
function add(m: Money, amount: number) {
  m.count += 1;
  m.amount = Math.round((m.amount + amount) * 100) / 100;
}
function emptyPeriod(): AccountPeriod {
  return {
    charged: empty(),
    disputed: empty(),
    won: empty(),
    rejected: empty(),
    inWork: empty(),
    awaiting: empty(),
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

/** Смещение America/New_York относительно UTC на дату, в часах (−4 летом, −5 зимой). */
function etOffsetHours(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(d);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-4";
  const m = tz.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) : -4;
}

function nextRun(at: { hour: number; minute: number; tz: "UTC" | "ET" }, now: Date): Date {
  const offset = at.tz === "ET" ? etOffsetHours(now) : 0;
  const candidate = new Date(now);
  candidate.setUTCHours(at.hour - offset, at.minute, 0, 0);
  while (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/** Статус кейса по статусам его строк: сперва то, что требует действия. */
function caseStatus(statuses: string[], recovered: number): string {
  const has = (s: string) => statuses.includes(s);
  if (has("REPLIED")) return "REPLIED";
  if (has("ESCALATED")) return "ESCALATED";
  if (has("AWAITING")) return "AWAITING";
  if (has("FILED")) return "FILED";
  if (has("DRAFT")) return "DRAFT";
  if (statuses.every((s) => s === "REFUNDED")) return "WON";
  if (recovered > 0) return "PARTIAL";
  if (statuses.every((s) => s === "CLOSED")) return "CLOSED";
  return "REJECTED";
}

const NEXT_RE = /next=(\d{4}-\d{2}-\d{2})/;

export async function buildDisputeBoard(now = new Date()) {
  const rows = await prisma.shippingAdjustment.findMany({
    where: {
      channel: "Amazon",
      storeId: { in: BOARD_STORE_IDS },
      adjustmentAmount: { lt: 0 },
    },
    select: {
      id: true,
      storeId: true,
      adjustmentDate: true,
      adjustmentAmount: true,
      carrier: true,
      disputeStatus: true,
      disputeCaseId: true,
      amountRecovered: true,
      lastDisputeEventAt: true,
      disputeEvents: {
        select: { eventType: true, eventDate: true, caseId: true, summary: true },
      },
    },
  });

  const since30 = addDays(isoDay(now), -30);
  const accounts: AccountBoard[] = BOARD_ACCOUNTS.map((a) => ({
    storeId: a.storeId,
    name: a.name,
    vps: STORE_ORIGINS[a.storeId]?.vps ?? null,
    cutoff: a.cutoff,
    all: emptyPeriod(),
    last30: emptyPeriod(),
    sinceCutoff: { charged: empty(), disputable: empty(), untouched: empty() },
  }));
  const byStore = new Map(accounts.map((a) => [a.storeId, a]));

  const caseMap = new Map<
    string,
    {
      caseId: string | null;
      storeId: string;
      statuses: string[];
      amount: number;
      recovered: number;
      rejectedAmount: number;
      carriers: Set<string>;
      openedAt: string | null;
      lastEventAt: string | null;
      nextOverride: string | null;
    }
  >();

  for (const r of rows) {
    const acc = byStore.get(r.storeId ?? "");
    if (!acc) continue;
    const amount = Math.abs(r.adjustmentAmount);
    const status = r.disputeStatus || "NONE";
    const recovered = r.amountRecovered ?? 0;
    const lastEventDay = r.lastDisputeEventAt ? isoDay(r.lastDisputeEventAt) : null;
    const recentStatus = lastEventDay != null && lastEventDay >= since30;

    const periods: Array<[AccountPeriod, boolean, boolean]> = [
      [acc.all, true, true],
      [acc.last30, r.adjustmentDate >= since30, recentStatus],
    ];
    for (const [p, chargedIn, statusIn] of periods) {
      if (chargedIn) add(p.charged, amount);
      if (!statusIn) continue;
      if (FILED_ANY.has(status)) add(p.disputed, amount);
      if (WON.has(status)) {
        p.won.count += 1;
        p.won.amount = Math.round((p.won.amount + recovered) * 100) / 100;
      }
      if (REJECTED.has(status)) add(p.rejected, amount);
      if (IN_WORK.has(status)) add(p.inWork, amount);
      if (AWAITING.has(status)) add(p.awaiting, amount);
    }

    if (r.adjustmentDate > acc.cutoff) {
      add(acc.sinceCutoff.charged, amount);
      if (status !== "NONE") add(acc.sinceCutoff.disputable, amount);
      else add(acc.sinceCutoff.untouched, amount);
    }

    if (status === "NONE" || status === "EXCLUDED_BLOCKED_ACCOUNT") continue;

    // Кейс строки — последний номер из её истории; черновики без номера
    // собираются в одну строку «к подаче» на аккаунт.
    const caseId = r.disputeCaseId ?? null;
    const key = caseId ? `${r.storeId}:${caseId}` : `${r.storeId}:draft`;
    let c = caseMap.get(key);
    if (!c) {
      c = {
        caseId,
        storeId: r.storeId!,
        statuses: [],
        amount: 0,
        recovered: 0,
        rejectedAmount: 0,
        carriers: new Set(),
        openedAt: null,
        lastEventAt: null,
        nextOverride: null,
      };
      caseMap.set(key, c);
    }
    c.statuses.push(status);
    c.amount += amount;
    c.recovered += recovered;
    if (REJECTED.has(status)) c.rejectedAmount += amount;
    if (r.carrier) c.carriers.add(r.carrier.toUpperCase());
    for (const e of r.disputeEvents) {
      if (e.eventType === "FILED" && (!c.openedAt || e.eventDate < c.openedAt)) c.openedAt = e.eventDate;
      if (!c.lastEventAt || e.eventDate > c.lastEventAt) c.lastEventAt = e.eventDate;
      const m = e.eventType === "NOTE" ? e.summary?.match(NEXT_RE) : null;
      if (m && (!c.nextOverride || m[1] > c.nextOverride)) c.nextOverride = m[1];
    }
  }

  const today = isoDay(now);
  const cases: BoardCase[] = [...caseMap.entries()].map(([key, c]) => {
    const status = caseStatus(c.statuses, c.recovered);
    const counts = new Map<string, number>();
    for (const s of c.statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
    const follow = FOLLOW_UP_DAYS[status];
    let nextActionDate: string | null = null;
    let nextAction: string | null = null;
    if (follow) {
      nextAction = follow.action;
      nextActionDate = c.nextOverride ?? addDays(c.lastEventAt ?? today, follow.days);
    }
    return {
      key,
      caseId: c.caseId,
      storeId: c.storeId,
      account: byStore.get(c.storeId)?.name ?? c.storeId,
      status,
      statusLabel: CASE_STATUS_LABEL[status] ?? status,
      rows: c.statuses.length,
      amount: Math.round(c.amount * 100) / 100,
      recovered: Math.round(c.recovered * 100) / 100,
      rejectedAmount: Math.round(c.rejectedAmount * 100) / 100,
      carriers: [...c.carriers].sort(),
      breakdown: [...counts.entries()]
        .map(([s, count]) => ({ status: s, count }))
        .sort((a, b) => b.count - a.count),
      openedAt: c.openedAt,
      lastEventAt: c.lastEventAt,
      nextActionDate,
      nextAction,
    };
  });

  // Сначала то, где пора действовать, потом закрытые.
  cases.sort((a, b) => {
    const an = a.nextActionDate ?? "9999";
    const bn = b.nextActionDate ?? "9999";
    if (an !== bn) return an.localeCompare(bn);
    return b.amount - a.amount;
  });

  const crons = await cronHealth(now);

  return {
    generatedAt: now.toISOString(),
    today,
    accounts,
    cases,
    crons,
    anyStale: crons.some((c) => c.stale),
  };
}

async function cronHealth(now: Date): Promise<CronHealth[]> {
  const out: CronHealth[] = [];
  for (const j of CRON_JOBS) {
    // Серверные кроны пишут jobName вида "penalty-monitor:store1" — по
    // аккаунту, чтобы сбой одного кабинета был виден отдельно.
    const where = { OR: [{ jobName: j.job }, { jobName: { startsWith: `${j.job}:` } }] };
    const last = await prisma.syncLog.findFirst({ where, orderBy: { startedAt: "desc" } });
    const lastOk = await prisma.syncLog.findFirst({
      where: { ...where, status: "done" },
      orderBy: { startedAt: "desc" },
    });
    const lastSuccessAt = lastOk ? (lastOk.completedAt ?? lastOk.startedAt) : null;
    const stale =
      !lastSuccessAt || now.getTime() - lastSuccessAt.getTime() > STALE_HOURS * 3600_000;
    out.push({
      job: j.job,
      label: j.label,
      where: j.where,
      schedule: j.schedule,
      lastStartedAt: last?.startedAt.toISOString() ?? null,
      lastFinishedAt: last?.completedAt?.toISOString() ?? null,
      lastStatus: last?.status ?? null,
      lastError: last?.error ?? null,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      nextRunAt: new Date(
        Math.min(...j.at.map((t) => nextRun(t, now).getTime()))
      ).toISOString(),
      stale,
    });
  }
  return out;
}
