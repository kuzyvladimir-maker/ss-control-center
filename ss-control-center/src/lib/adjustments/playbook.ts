/**
 * Плейбук споров по корректировкам доставки Amazon Buy Shipping.
 *
 * Собран из реального опыта 20.09–01.10.2026 по Salutem Solutions и
 * AMZ Commerce: память memory/shipping_adjustments_dispute_path.md,
 * memory/rule_shipping_penalty_monitor.md, транскрипты кейсов, результаты
 * монитора. Постоянная копия — wiki/business/amazon-shipping-adjustments-playbook.md
 * в workspace Джеки. Меняется вместе с опытом: новый проверенный исход —
 * новая строка здесь и в wiki.
 */

export interface PlaybookSection {
  id: string;
  title: string;
  items: string[];
}

export const PLAYBOOK: PlaybookSection[] = [
  {
    id: "where",
    title: "Где искать штрафы",
    items: [
      "SP-API Finances v2024-06-19 /finances/2024-06-19/transactions: штраф = Adjustment / LabmanLabelChargeBack, item PostageBilling_PostageAdjustment. Там же CustomerPackagingCharge (уплачено за лейбл) и CarrierPackagingCharge (выставил перевозчик).",
      "Старый v0 financialEvents номер заказа не даёт — для привязки не использовать.",
      "Лаг публикации ~48 часов: свежие списания появляются со следующим прогоном.",
      "Кредит по выигранному спору приходит как MiscellaneousLedgerAdjustment / MiscAdjustment БЕЗ номера заказа (в Transaction View — тип Other, «Shipping Charge Adjustment»). Привязка — по уникальной сумме, допуск $0.05; неоднозначно — не закрывать.",
      "Поиск в Transaction View по order ID кредит не показывает — искать по дате или через SP-API.",
      "Отсечка базового пакета: Salutem — по 11.09.2026, AMZ Commerce — по 18.09.2026. Всё позже — новые штрафы монитора.",
    ],
  },
  {
    id: "measure",
    title: "Как снять замер перевозчика",
    items: [
      "Единственный полный источник аудита — Seller Central → Payments → Transaction View → /payments/event/view?accountType=ALL&orderId=<ORDER> → клик по сумме в колонке Total → /payments/event/details?financialEventId=<ID>.",
      "Transaction Details даёт Customer Entered Dimensions/Weight, Carrier Audited Dimensions/Weight, тип коррекции, уплачено, итог перевозчика и разбивку (base postage, fuel, residential, DAS, discount).",
      "Только с VPS этого аккаунта: Salutem 209.208.63.54, AMZ Commerce 209.208.78.229. Массово — харвестер `shipping_penalty_monitor.py harvester <store>` в консоли Chrome на VPS, затем ingest-audit.",
      "FedEx Track API = аудит (13×42×11 сошлось с Amazon до цифры), годится вторым свидетелем; вес там фактический, а не оплачиваемый.",
      "UPS Track API = наш же манифест, а не аудит. Доказательством не является никогда.",
      "Перед входом проверить, что VPS никто не занял: второй RDP выбивает первого.",
    ],
  },
  {
    id: "classify",
    title: "Как классифицировать",
    items: [
      "STRONG — GROSS_DIM: одна ось ≥2× и +8″, две другие ±1.5″. Ровно так одобрены 6 FedEx на $848.82.",
      "MEDIUM — GROSS_WEIGHT: габариты ±1″, вес ≥1.5× и выше объёмного.",
      "CHECK — UNEXPLAINED_CHARGE: замер не изменился, перевозчик выставил ≥2× от уплаченного, ≥$10. Сначала открыть Transaction Details.",
      "WEAK — UNIFORM_GROWTH, DISCREPANCY, DECLARED_UNDER_DIMWEIGHT: шум сканера, рост нескольких осей, заявлен вес ниже объёмного. Amazon отказывает.",
      "NO — SURCHARGE_ONLY: замер не изменился, это адресные надбавки (residential, DAS, super rural). Не оспариваются.",
      "NEEDS_AUDIT — нет аудит-габаритов: сначала харвест Transaction Details с VPS.",
    ],
  },
  {
    id: "file",
    title: "Как подавать",
    items: [
      "Один кейс = один аккаунт + один тип дефекта (пачка). Сборная солянка не работает.",
      "Кабинет и VPS — того юрлица, на которое упало списание. Номер кейса и заказы другого аккаунта в обращении не упоминать никогда.",
      "Путь: Help → My issue is not listed → Buy Shipping → Refund → How to Request Refund → Order ID → Contact an associate → Get help with Buy Shipping → ASIN → Email или Chat. После AI-рерайта жать «Use original text».",
      "В открытом кейсе — Reply → Chat (вкладки Email нет). Описание чата короткое: больше ~1200 символов — «Too many characters»; остальное сообщениями. Чат 9:00–21:00 ET. Транскрипт сохранять руками.",
      "В тело: order ID, трекинг, заявленные и аудированные габариты/вес, оплачиваемый вес, сумма; CSV со всеми строками и скриншот Transaction Details по каждому заказу.",
      "«Подано» = номер кейса виден в Manage support cases. Слова Seller Assistant «case created» доказательством не являются. Номер кейса записать в реестр в тот же шаг.",
      "Выиграно = кредит в Payments / SP-API. Письмо «approved» — ещё не деньги (одобрено 29.09 письмом, кредит подтверждён 01.10 по Transaction View).",
    ],
  },
];

export interface Lesson {
  text: string;
  evidence: string;
}

/** Что сработало — проверено кредитом или письменной эскалацией. */
export const WHAT_WORKS: Lesson[] = [
  {
    text: "Аномалия по одной оси габарита: одна сторона 41–42″ (или 22–39″) при двух совпавших и весе не выше заявленного — «consistent with a measurement error».",
    evidence: "кейс 22167316661, Salutem: 6 FedEx, $848.82 из $848.85, кредит MiscAdjustment 29.09 (Released), сверено 01.10",
  },
  {
    text: "Довод через объёмный вес неверных габаритов: оплачиваемый вес = Д×Ш×В/139 от ошибочной стороны, а посылка реально лёгкая.",
    evidence: "112-9151636-5460222: 13×42×11 → 37 lb оплачиваемых при 11 lb на весах; зачислено",
  },
  {
    text: "Просить, чтобы Amazon сам подал measurement dispute перевозчику и тот проверил свои audited scan data по трекингам.",
    evidence: "24.09 Rahul (22167316661): Amazon подал спор на FedEx от своего имени → FedEx одобрил 29.09",
  },
  {
    text: "Один кейс на пачку одного типа; новые однотипные строки — дописывать в тот же открытый кейс, а не плодить новые.",
    evidence: "3 FedEx добавлены в 22167316661 30.09, письменное подтверждение Mary",
  },
  {
    text: "Заводская маркировка коробки как доказательство (ULINE S-12593, 12×10×12): «12-дюймовая сторона не может намериться 41-42».",
    evidence: "fedex_uline_S-12593_evidence.pdf в 22167316661",
  },
];

/** Что не сработало — проверено отказами Amazon. */
export const WHAT_FAILS: Lesson[] = [
  {
    text: "UPS: сравнение с SSCC carrier-track — это сравнение заявленного с заявленным, Track API отдаёт наш манифест.",
    evidence: "кейс 22167069131: Amazon письменно — «manifested data, not audited re-measurement»; финальный отказ",
  },
  {
    text: "Довод «вес вырос в 6–15 раз»: на деле это объёмный вес коробки, заявленный вес был ниже объёмного.",
    evidence: "кейс 22357089981 (4 UPS, $75.46): отказ 01.10, dim weight 73/75/43 lb",
  },
  {
    text: "Слабые строки: +30–40% при тех же габаритах и рост нескольких сторон на 1–3″ — шаблонный отказ «consistent with the carrier's measurement».",
    evidence: "кейс 22197250461: 31 из 37 отказано 27.09; 22196683861: финал по всем 68 заказам 26.09",
  },
  {
    text: "Переоткрыть кейс через 5 дней после ответа нельзя; «no further action» — не переоткрывать.",
    evidence: "Guidelines for contacting SPS, проверено 26.09",
  },
  {
    text: "Дубли кейсов запрещены — путают Amazon и ломают учёт (пустой дубль 22198660051 при 22198202261).",
    evidence: "AMZ Commerce, 22.09",
  },
  {
    text: "Просить у Amazon raw scan images / reason codes бессмысленно — у них этого нет.",
    evidence: "письменно Catherine A. 22.09, Boddeda S. 23.09, Vigneshwaran K. 25.09",
  },
  {
    text: "«Dispute is valid» от первой линии — не возврат; эскалации выше live chat нет (кнопки нет, help-статьи нет).",
    evidence: "22167316661: «valid» 21.09 → «идите в FedEx» 22.09; проверено 26.09",
  },
  {
    text: "USPS APV и адресные надбавки (residential, DAS, super rural) не возмещаются.",
    evidence: "кейс 22235365411 (7 USPS) — отказ 24.09; 22167699051 — состав сурчарджей",
  },
  {
    text: "Claims Protected по Buy Shipping не распространяется на carrier shipping charge corrections.",
    evidence: "111-7262274-1641013, отказ 27.09",
  },
];

/** Номер кейса-прецедента — только для своего аккаунта. */
export const PRECEDENT_BY_STORE: Record<string, { caseId: string; note: string } | undefined> = {
  store1: {
    caseId: "22167316661",
    note: "six FedEx shipments with the same single-axis pattern were reviewed, the carrier approved the refunds and the credit posted on Sep 29, 2026",
  },
};

/** Открытый кейс, в который по указанию оператора можно дописывать однотипные строки. */
export const APPEND_CASE_BY_STORE: Record<string, { caseId: string; pattern: string } | undefined> = {
  store1: { caseId: "22167316661", pattern: "SINGLE_AXIS_SCAN_ERROR" },
};
