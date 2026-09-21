/**
 * Откуда подано обращение: кабинет Seller Central и VPS.
 *
 * 20.09.2026 в кейс Salutem Solutions попали 16 строк AMZ Commerce — номера
 * заказов одного кабинета ушли в обращение другого. Это прямой риск связки
 * аккаунтов (related), и он дороже всех спорных сумм вместе взятых. Поэтому
 * соответствие «аккаунт → VPS» живёт в коде, а не в голове оператора, и
 * событие подачи без указания кабинета и VPS вообще не создаётся.
 *
 * Правило одно: кейс подаётся из кабинета того юрлица, на которое упало
 * списание, и со своего VPS. Никаких исключений, никакого «один раз можно».
 */

export interface StoreOrigin {
  /** storeId как в ShippingAdjustment.storeId */
  storeId: string;
  /** Юрлицо — как оно называется в Seller Central */
  account: string;
  /** IP VPS, с которого разрешена работа в этом кабинете */
  vps: string;
  /** Аккаунт заблокирован — подача запрещена совсем */
  blocked: boolean;
  /** Почему заблокирован — показываем в реестре, чтобы не переспрашивать */
  blockedReason?: string;
}

/**
 * Справочник подачи. Аккаунта нет в таблице — значит, подача с него не
 * согласована: добавлять сюда осознанно, а не догадываться в рантайме.
 */
export const STORE_ORIGINS: Record<string, StoreOrigin> = {
  store1: {
    storeId: "store1",
    account: "Salutem Solutions",
    vps: "209.208.63.54",
    blocked: false,
  },
  store3: {
    storeId: "store3",
    account: "AMZ Commerce LLC",
    vps: "209.208.78.229",
    blocked: false,
  },
  store5: {
    storeId: "store5",
    account: "Retailer Distributor",
    vps: "209.208.79.131",
    blocked: true,
    blockedReason:
      "Amazon-аккаунт заблокирован — новые обращения смысла не имеют, решение Владимира 20.09.2026",
  },
};

/** Терминальный статус строк заблокированного аккаунта. */
export const EXCLUDED_BLOCKED_ACCOUNT = "EXCLUDED_BLOCKED_ACCOUNT" as const;

/** Типы событий, означающие исходящую подачу из кабинета. */
export const SUBMISSION_EVENT_TYPES = ["FILED", "CLARIFICATION", "ESCALATED"] as const;

export function isSubmissionEvent(eventType: string): boolean {
  return (SUBMISSION_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function originFor(storeId: string | null | undefined): StoreOrigin | null {
  if (!storeId) return null;
  return STORE_ORIGINS[storeId] ?? null;
}

/** Аккаунт заблокирован — строки видны в реестре, но в очередь спора не идут. */
export function isBlockedStore(storeId: string | null | undefined): boolean {
  return originFor(storeId)?.blocked === true;
}

export interface SubmissionOriginInput {
  /** storeId строки списания — с чем обязан совпасть кабинет подачи */
  rowStoreId: string | null;
  submittedFromStore?: string | null;
  submittedFromVps?: string | null;
}

export type OriginCheck =
  | { ok: true; submittedFromStore: string; submittedFromVps: string }
  | { ok: false; error: string };

/**
 * Проверка источника подачи. Возвращает ошибку текстом — её показываем
 * оператору дословно: он должен понимать, что именно не сошлось.
 */
export function checkSubmissionOrigin(input: SubmissionOriginInput): OriginCheck {
  const store = (input.submittedFromStore || "").trim();
  const vps = (input.submittedFromVps || "").trim();

  if (!store || !vps) {
    return {
      ok: false,
      error:
        "для события подачи обязательны submittedFromStore и submittedFromVps — " +
        "без них не видно, из какого кабинета и с какого VPS ушло обращение",
    };
  }

  const origin = originFor(store);
  if (!origin) {
    return {
      ok: false,
      error:
        `аккаунт ${store} не заведён в справочнике подачи — добавьте его в ` +
        "lib/adjustments/submission-origin.ts вместе с его VPS, подача вслепую запрещена",
    };
  }

  if (origin.blocked) {
    return {
      ok: false,
      error: `${origin.account}: подача запрещена — ${origin.blockedReason ?? "аккаунт заблокирован"}`,
    };
  }

  if (input.rowStoreId && input.rowStoreId !== store) {
    const rowOrigin = originFor(input.rowStoreId);
    return {
      ok: false,
      error:
        `списание принадлежит аккаунту ${rowOrigin?.account ?? input.rowStoreId}, ` +
        `а подача указана из ${origin.account} — смешивать кабинеты нельзя (related)`,
    };
  }

  if (vps !== origin.vps) {
    return {
      ok: false,
      error:
        `${origin.account} работает с VPS ${origin.vps}, а указан ${vps} — ` +
        "подача с чужого VPS связывает аккаунты",
    };
  }

  return { ok: true, submittedFromStore: store, submittedFromVps: vps };
}

/**
 * Расхождение в уже записанном событии: пригодилось бы, если событие завели
 * до валидации или импортом. Реестр красит такие строки, чтобы смешение
 * ловилось глазами.
 */
export function originMismatch(
  rowStoreId: string | null,
  submittedFromStore: string | null,
  submittedFromVps: string | null
): boolean {
  if (!submittedFromStore && !submittedFromVps) return false;
  const origin = originFor(submittedFromStore);
  if (!origin) return true;
  if (rowStoreId && rowStoreId !== submittedFromStore) return true;
  if (submittedFromVps && submittedFromVps !== origin.vps) return true;
  return false;
}
