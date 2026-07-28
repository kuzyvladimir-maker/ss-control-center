"use client";

import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Clock3,
  Database,
  ExternalLink,
  Fingerprint,
  GitBranch,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
} from "lucide-react";
import {
  FormEvent,
  Fragment,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  Btn,
  HeroGreenCard,
  HeroLabel,
  KpiCard,
  PageHead,
  Panel,
  PanelBody,
  PanelHeader,
} from "@/components/kit";
import {
  CatalogTabs,
  type ProductTruthCatalogView,
} from "@/components/catalog/CatalogTabs";
import { cn } from "@/lib/utils";

type ApiEnvelope<T> = {
  ok: boolean;
  status: "READ_ONLY" | "OFF" | "BLOCKED" | "INVALID_REQUEST";
  data?: T;
  reason?: string;
  code?: string;
  message?: string;
};

type Claims = {
  readOnly: boolean;
  databaseWrites: false;
  legacyFallback: false;
  providerCalls: false;
  paidCalls: false;
  marketplaceMutations: false;
  procurementMutations: false;
  consumerCutoverClaimed: false;
};

type Overview = {
  schemaVersion: string;
  view: "OVERVIEW";
  readContractVersion: string;
  readAt: string;
  databaseTargetFingerprint: string;
  authoritativeManifestSha256: string;
  locality: { zip: string };
  scope: {
    denominator: number;
    partitions: Array<{
      channel: "amazon" | "walmart";
      storeIndex: number;
      count: number;
    }>;
  };
  readiness: {
    bundleFactory: { ready: number; blocked: number };
    listingImprovement: { ready: number; blocked: number };
    unitEconomics: {
      ready: number;
      blocked: number;
      fact: number;
      estimate: number;
      unsourceable: number;
      missing: number;
      invalid: number;
    };
    procurement: { ready: number; blocked: number };
  };
  catalog: {
    canonicalVariants: number;
    variantsWithExactContent: number;
    contentObservations: number;
    offerObservations: number;
    firstPartyOfferObservations: number;
    localOfferObservations: number;
  };
  operations: {
    runs: number;
    activeRuns: number;
    blockedRuns: number;
    operationalQueueJobs: number;
    activeQueueJobs: number;
    reservedCalls: number;
    reservedUnits: number;
  };
  claims: Claims;
};

type ProductContent = {
  observationId: string;
  donorProductId: string;
  sourceUrl: string;
  sourceApi: string;
  observedAt: string;
  contentHash: string;
  facts: unknown;
  runId: string | null;
  approvalId: string | null;
  meteredReceiptId: string | null;
};

type VariantOffer = {
  observationId: string;
  retailer: string;
  retailerProductId: string;
  title: string | null;
  price: number | null;
  pricePerUnit: number | null;
  packSizeSeen: number | null;
  currency: string;
  zip: string | null;
  localityEvidence: string | null;
  inStock: boolean | null;
  productUrl: string | null;
  sellerName: string | null;
  isFirstParty: boolean;
  sourceApi: string | null;
  observedAt: string;
  runId: string | null;
  approvalId: string | null;
  meteredReceiptId: string | null;
};

type Variant = {
  canonicalVariantId: string;
  variantKey: string;
  identityHash: string;
  keyVersion: string;
  brand: string;
  productLine: string | null;
  flavor: string | null;
  modifiers: unknown[];
  form: string | null;
  size: {
    dimension: string;
    amount: number;
    unit: string;
    outerPackCount: number;
  };
  identity: unknown;
  sourceCount: number;
  contentObservationCount: number;
  latestContent: ProductContent | null;
  offers: VariantOffer[];
};

type VariantsData = {
  schemaVersion: string;
  view: "VARIANTS";
  readAt: string;
  databaseTargetFingerprint: string;
  query: string | null;
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
  variants: Variant[];
  claims: Claims;
};

type PriceOption = {
  observationId: string;
  eligibility: "FACT" | "ESTIMATE";
  matchTier: string;
  packagePrice: number | null;
  packSizeSeen: number | null;
  observedUnitPrice: number;
  targetComparableUnitPrice: number;
  currency: string;
  retailer: string;
  retailerProductId: string;
  via: string;
  productUrl: string;
  sellerName: string | null;
  sourceApi: string | null;
  locality: { zip: string | null; evidence: string };
  freshness: { observedAt: string; ageMs: number; maxAgeMs: number };
  sourceRun: {
    runId: string | null;
    approvalId: string | null;
    meteredReceiptId: string | null;
  };
  policyReasonCodes: readonly string[];
};

type RecipeComponent = {
  componentEvidenceId: string;
  componentIndex: number;
  product: string;
  flavor: string | null;
  size: string | null;
  qty: number;
  targetCanonicalVariantId: string;
  evidenceStatus: string;
  content: null | {
    facts: {
      title: string | null;
      mainImageUrl: string | null;
      imageUrls: string[];
    };
    provenance: {
      sourceUrl: string;
      sourceApi: string;
      observedAt: string;
      contentHash: string;
    };
  };
  contentBlockers: string[];
};

type CostRecord = {
  id: string;
  totalCost: number | null;
  costPerUnit: number | null;
  productCost: number | null;
  packagingCost: number | null;
  iceCost: number | null;
  packSize: number | null;
  currency: string;
  evidenceOutcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE";
  effectiveDate: string;
  createdAt: string;
  source: string;
  runId: string | null;
  approvalId: string | null;
  matcherVersion: string;
  pricePolicyVersion: string;
};

type Snapshot = {
  contractVersion: string;
  snapshot: {
    sku: string;
    channel: string;
    storeIndex: number;
    listingKey: string;
    asOf: string;
    maxPriceAgeMs: number;
    skuCostId: string | null;
  };
  recipe: { components: RecipeComponent[]; blockers: string[] };
  views: {
    bundleFactory: {
      ready: boolean;
      blockers: string[];
      components: RecipeComponent[];
    };
    listingImprovement: {
      ready: boolean;
      blockers: string[];
      components: RecipeComponent[];
    };
    unitEconomics: {
      status: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "MISSING" | "INVALID";
      current: CostRecord | null;
      blockers: string[];
    };
    procurement: {
      ready: boolean;
      blockers: string[];
      components: Array<{
        componentIndex: number;
        product: string;
        requiredQuantity: number;
        factualOptions: PriceOption[];
        estimateOptions: PriceOption[];
        blockers: string[];
      }>;
    };
  };
};

type ListingsData = {
  schemaVersion: string;
  view: "LISTINGS";
  readContractVersion: string;
  readAt: string;
  databaseTargetFingerprint: string;
  page: {
    channel: "amazon" | "walmart";
    storeIndex: number;
    limit: number;
    cursor: string | null;
    nextCursor: string | null;
    manifestInventory: {
      scopeCount: number;
      partitions: Array<{
        channel: "amazon" | "walmart";
        storeIndex: number;
        scopeCount: number;
      }>;
    };
  };
  snapshots: Snapshot[];
  claims: Claims;
};

type OperationsData = {
  schemaVersion: string;
  view: "OPERATIONS";
  readAt: string;
  databaseTargetFingerprint: string;
  runs: Array<{
    runId: string;
    approvalId: string;
    mode: string;
    environment: string;
    status: string;
    manifestSha256: string;
    targetCount: number;
    planSha256: string;
    eventChainHead: string;
    reportSha256: string | null;
    artifactIndexSha256: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    itemCounts: Record<string, number>;
    queueCounts: Record<string, number>;
    budgets: Array<{
      provider: string;
      operations: unknown;
      maxCalls: number;
      reservedCalls: number;
      maxUnits: number | null;
      reservedUnits: number;
      issuedAt: string;
      expiresAt: string;
      receiptCounts: Record<string, number>;
    }>;
    blockers: Array<{
      listingKey: string;
      status: string;
      stage: string;
      lastError: string | null;
      updatedAt: string;
    }>;
  }>;
  claims: Claims;
};

type ViewData = Overview | VariantsData | ListingsData | OperationsData;

const integer = new Intl.NumberFormat("en-US");
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

function fmt(value: number): string {
  return integer.format(value);
}

function money(value: number | null | undefined): string {
  return value == null ? "—" : usd.format(value);
}

function localTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentTitle(content: ProductContent | null): string | null {
  const facts = asObject(content?.facts);
  return typeof facts?.title === "string" ? facts.title : null;
}

function contentImage(content: ProductContent | null): string | null {
  const facts = asObject(content?.facts);
  return typeof facts?.mainImageUrl === "string" ? facts.mainImageUrl : null;
}

function statusTone(status: string): string {
  if (["READY", "FACT", "done", "completed", "succeeded"].includes(status)) {
    return "border-green/20 bg-green-soft text-green-ink";
  }
  if (["ESTIMATE", "running", "queued", "prepared", "retry_wait"].includes(status)) {
    return "border-warn/20 bg-warn-tint text-warn-strong";
  }
  if (["UNSOURCEABLE", "MISSING", "INVALID", "blocked", "ambiguous", "failed"].includes(status)) {
    return "border-danger/20 bg-danger-tint text-danger";
  }
  return "border-rule bg-bg-elev text-ink-3";
}

function StatusPill({ children }: { children: string }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
      statusTone(children),
    )}>
      {children}
    </span>
  );
}

function Binding({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-4">
        {label}
      </div>
      <div className="truncate font-mono text-[11px] text-ink-2" title={value}>
        {value}
      </div>
    </div>
  );
}

function ErrorPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-danger/25 bg-danger-tint px-4 py-4 text-danger">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <AlertCircle size={16} />
        {title}
      </div>
      <div className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        {children}
      </div>
    </div>
  );
}

function RuntimeOff() {
  return (
    <Panel>
      <PanelBody>
        <div className="mx-auto max-w-2xl py-12 text-center">
          <CircleOff size={30} className="mx-auto text-ink-4" />
          <div className="mt-3 text-[16px] font-semibold text-ink">
            Product Truth read-only runtime is OFF
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            The module is installed but deliberately disconnected. Enabling it
            requires the exact authoritative manifest SHA, exact database target
            fingerprint, freshness policy, and a matching read-only confirmation.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-rule bg-bg-elev px-3 py-2 text-[11.5px] text-ink-2">
            <ShieldCheck size={14} className="text-green-ink" />
            No legacy fallback, provider call, database write, or marketplace action occurred.
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function endpointFor(input: {
  view: ProductTruthCatalogView;
  channel: "amazon" | "walmart";
  storeIndex: number;
  search: string;
  variantsCursor: string | null;
  listingsCursor: string | null;
}): string {
  if (input.view === "overview" || input.view === "readiness") {
    return "/api/catalog/product-truth/overview";
  }
  if (input.view === "products") {
    const params = new URLSearchParams({ limit: "25" });
    if (input.search) params.set("q", input.search);
    if (input.variantsCursor) params.set("cursor", input.variantsCursor);
    return `/api/catalog/product-truth/variants?${params}`;
  }
  if (input.view === "runs") {
    return "/api/catalog/product-truth/operations?limit=20";
  }
  const params = new URLSearchParams({
    channel: input.channel,
    store: String(input.storeIndex),
    limit: "25",
  });
  if (input.listingsCursor) params.set("cursor", input.listingsCursor);
  return `/api/catalog/product-truth/listings?${params}`;
}

export function ProductTruthCatalog({
  initialView,
}: {
  initialView: ProductTruthCatalogView;
}) {
  const [data, setData] = useState<ViewData | null>(null);
  const [envelopeStatus, setEnvelopeStatus] = useState<
    ApiEnvelope<ViewData>["status"] | null
  >(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [channel, setChannel] = useState<"amazon" | "walmart">("walmart");
  const [storeIndex, setStoreIndex] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [variantsCursor, setVariantsCursor] = useState<string | null>(null);
  const [variantsHistory, setVariantsHistory] = useState<Array<string | null>>([]);
  const [listingsCursor, setListingsCursor] = useState<string | null>(null);
  const [listingsHistory, setListingsHistory] = useState<Array<string | null>>([]);

  const endpoint = useMemo(() => endpointFor({
    view: initialView,
    channel,
    storeIndex,
    search,
    variantsCursor,
    listingsCursor,
  }), [
    initialView,
    channel,
    storeIndex,
    search,
    variantsCursor,
    listingsCursor,
  ]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as ApiEnvelope<ViewData>;
      setEnvelopeStatus(payload.status);
      if (!response.ok || !payload.ok) {
        throw Object.assign(
          new Error(payload.message || `HTTP ${response.status}`),
          { code: payload.code },
        );
      }
      setData(payload.data ?? null);
    } catch (caught) {
      if (signal.aborted) return;
      setData(null);
      setError({
        code: caught !== null && typeof caught === "object" && "code" in caught
          ? String(caught.code)
          : undefined,
        message: caught instanceof Error ? caught.message : "Unknown read failure",
      });
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reload]);

  useEffect(() => {
    setListingsCursor(null);
    setListingsHistory([]);
  }, [channel, storeIndex]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setVariantsCursor(null);
    setVariantsHistory([]);
    setSearch(searchDraft.trim());
  };

  const refresh = () => setReload((value) => value + 1);
  const readAt = data?.readAt;

  return (
    <div className="space-y-5">
      <PageHead
        title="Catalog / Product Truth"
        subtitle={
          <>
            One channel-independent source of truth for Bundle Factory, listing
            improvement, unit economics, and procurement
            {readAt ? ` · read ${localTime(readAt)}` : ""}
          </>
        }
        actions={(
          <div className="flex items-center gap-2">
            <span className={cn(
              "rounded-full border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide",
              envelopeStatus === "READ_ONLY"
                ? "border-green/20 bg-green-soft text-green-ink"
                : envelopeStatus === "OFF"
                  ? "border-rule bg-bg-elev text-ink-3"
                  : "border-warn/20 bg-warn-tint text-warn-strong",
            )}>
              {envelopeStatus ?? "checking"}
            </span>
            <Btn
              variant="default"
              icon={<RefreshCw size={13} />}
              onClick={refresh}
              loading={loading}
            >
              Refresh
            </Btn>
          </div>
        )}
      />
      <CatalogTabs activeView={initialView} />

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green/15 bg-green-soft/60 px-3 py-2 text-[12px] text-ink-2">
        <span className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-green-ink" />
          Canonical read-only surface · no legacy fallback · no paid/provider path
        </span>
        <span className="font-mono text-[10.5px] text-ink-4">
          product-truth read-contract/3.2.0
        </span>
      </div>

      {error ? (
        <ErrorPanel title="Product Truth projection blocked">
          {error.code ? <span className="font-mono">{error.code}: </span> : null}
          {error.message} The API failed closed and did not substitute legacy catalog data.
        </ErrorPanel>
      ) : envelopeStatus === "OFF" ? (
        <RuntimeOff />
      ) : loading && !data ? (
        <Panel>
          <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-3">
            <Loader2 size={16} className="animate-spin" />
            Reading canonical Product Truth…
          </div>
        </Panel>
      ) : data ? (
        <>
          {initialView === "overview" && data.view === "OVERVIEW"
            ? <OverviewView data={data} />
            : null}
          {initialView === "products" && data.view === "VARIANTS"
            ? (
              <ProductsView
                data={data}
                searchDraft={searchDraft}
                onSearchDraft={setSearchDraft}
                onSubmitSearch={submitSearch}
                onClearSearch={() => {
                  setSearchDraft("");
                  setSearch("");
                  setVariantsCursor(null);
                  setVariantsHistory([]);
                }}
                onNext={() => {
                  if (!data.nextCursor) return;
                  setVariantsHistory((history) => [...history, variantsCursor]);
                  setVariantsCursor(data.nextCursor);
                }}
                onPrevious={() => {
                  const previous = variantsHistory.at(-1);
                  if (previous === undefined) return;
                  setVariantsCursor(previous);
                  setVariantsHistory((history) => history.slice(0, -1));
                }}
                hasPrevious={variantsHistory.length > 0}
              />
            )
            : null}
          {initialView === "recipes" && data.view === "LISTINGS"
            ? (
              <ListingsShell
                data={data}
                channel={channel}
                storeIndex={storeIndex}
                onChannel={setChannel}
                onStoreIndex={setStoreIndex}
                onNext={() => {
                  if (!data.page.nextCursor) return;
                  setListingsHistory((history) => [...history, listingsCursor]);
                  setListingsCursor(data.page.nextCursor);
                }}
                onPrevious={() => {
                  const previous = listingsHistory.at(-1);
                  if (previous === undefined) return;
                  setListingsCursor(previous);
                  setListingsHistory((history) => history.slice(0, -1));
                }}
                hasPrevious={listingsHistory.length > 0}
              >
                <RecipesView data={data} />
              </ListingsShell>
            )
            : null}
          {initialView === "offers" && data.view === "LISTINGS"
            ? (
              <ListingsShell
                data={data}
                channel={channel}
                storeIndex={storeIndex}
                onChannel={setChannel}
                onStoreIndex={setStoreIndex}
                onNext={() => {
                  if (!data.page.nextCursor) return;
                  setListingsHistory((history) => [...history, listingsCursor]);
                  setListingsCursor(data.page.nextCursor);
                }}
                onPrevious={() => {
                  const previous = listingsHistory.at(-1);
                  if (previous === undefined) return;
                  setListingsCursor(previous);
                  setListingsHistory((history) => history.slice(0, -1));
                }}
                hasPrevious={listingsHistory.length > 0}
              >
                <OffersView data={data} />
              </ListingsShell>
            )
            : null}
          {initialView === "quality" && data.view === "LISTINGS"
            ? (
              <ListingsShell
                data={data}
                channel={channel}
                storeIndex={storeIndex}
                onChannel={setChannel}
                onStoreIndex={setStoreIndex}
                onNext={() => {
                  if (!data.page.nextCursor) return;
                  setListingsHistory((history) => [...history, listingsCursor]);
                  setListingsCursor(data.page.nextCursor);
                }}
                onPrevious={() => {
                  const previous = listingsHistory.at(-1);
                  if (previous === undefined) return;
                  setListingsCursor(previous);
                  setListingsHistory((history) => history.slice(0, -1));
                }}
                hasPrevious={listingsHistory.length > 0}
              >
                <QualityView data={data} />
              </ListingsShell>
            )
            : null}
          {initialView === "runs" && data.view === "OPERATIONS"
            ? <OperationsView data={data} />
            : null}
          {initialView === "readiness" && data.view === "OVERVIEW"
            ? <ReadinessView data={data} />
            : null}
        </>
      ) : null}
    </div>
  );
}

function readinessPercent(ready: number, denominator: number): string {
  if (denominator === 0) return "0%";
  return `${((ready / denominator) * 100).toFixed(1)}%`;
}

function ReadinessCard({
  title,
  ready,
  blocked,
  detail,
}: {
  title: string;
  ready: number;
  blocked: number;
  detail: string;
}) {
  const denominator = ready + blocked;
  return (
    <div className="rounded-xl border border-rule bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-[11px] text-ink-4">{detail}</div>
        </div>
        <StatusPill>{blocked === 0 && denominator > 0 ? "READY" : "BLOCKED"}</StatusPill>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular text-ink">
          {readinessPercent(ready, denominator)}
        </span>
        <span className="text-[11.5px] text-ink-3">
          {fmt(ready)} / {fmt(denominator)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elev">
        <div
          className="h-full rounded-full bg-green"
          style={{ width: denominator ? `${(ready / denominator) * 100}%` : "0%" }}
        />
      </div>
    </div>
  );
}

function OverviewView({ data }: { data: Overview }) {
  const economics = data.readiness.unitEconomics;
  return (
    <>
      <HeroGreenCard>
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <HeroLabel>Authoritative Phase 1 denominator</HeroLabel>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="text-4xl font-semibold tabular text-white">
                {fmt(data.scope.denominator)}
              </span>
              <span className="text-[13px] text-white/75">
                exact Amazon + Walmart listing scopes
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-white/80">
              Every number below is reconciled to one immutable manifest. Content
              readiness and price/COGS outcome stay independent; estimates never
              become content truth.
            </p>
          </div>
          <div className="grid gap-2 text-[11px] text-white/75">
            <div className="rounded-lg bg-white/10 px-3 py-2">
              <div className="uppercase tracking-wide text-white/55">Manifest</div>
              <div className="mt-0.5 truncate font-mono" title={data.authoritativeManifestSha256}>
                {data.authoritativeManifestSha256}
              </div>
            </div>
            <div className="rounded-lg bg-white/10 px-3 py-2">
              <div className="uppercase tracking-wide text-white/55">Locality</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <MapPin size={12} /> Clearwater ZIP {data.locality.zip}
              </div>
            </div>
          </div>
        </div>
      </HeroGreenCard>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ReadinessCard
          title="Bundle Factory"
          ready={data.readiness.bundleFactory.ready}
          blocked={data.readiness.bundleFactory.blocked}
          detail="Exact reusable content"
        />
        <ReadinessCard
          title="Listing Improvement"
          ready={data.readiness.listingImprovement.ready}
          blocked={data.readiness.listingImprovement.blocked}
          detail="Exact variant facts"
        />
        <ReadinessCard
          title="Unit Economics"
          ready={economics.ready}
          blocked={economics.blocked}
          detail={`${fmt(economics.fact)} fact · ${fmt(economics.estimate)} estimate`}
        />
        <ReadinessCard
          title="Procurement"
          ready={data.readiness.procurement.ready}
          blocked={data.readiness.procurement.blocked}
          detail="Fresh eligible first-party options"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Canonical variants"
          value={fmt(data.catalog.canonicalVariants)}
          icon={<Database size={15} />}
          href="/catalog?view=products"
        />
        <KpiCard
          label="Variants with content"
          value={fmt(data.catalog.variantsWithExactContent)}
          icon={<BadgeCheck size={15} />}
          href="/catalog?view=products"
        />
        <KpiCard
          label="First-party observations"
          value={fmt(data.catalog.firstPartyOfferObservations)}
          icon={<Store size={15} />}
          href="/catalog?view=offers"
        />
        <KpiCard
          label="Active queue"
          value={fmt(data.operations.activeQueueJobs)}
          icon={<GitBranch size={15} />}
          iconVariant={data.operations.activeQueueJobs ? "warn" : "default"}
          href="/catalog?view=runs"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Manifest partitions" count={data.scope.partitions.length} />
          <div className="divide-y divide-rule">
            {data.scope.partitions.map((partition) => (
              <div
                key={`${partition.channel}:${partition.storeIndex}`}
                className="flex items-center justify-between px-4 py-3 text-[12.5px]"
              >
                <div className="flex items-center gap-2">
                  <span className="capitalize font-medium text-ink">{partition.channel}</span>
                  <span className="rounded bg-bg-elev px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
                    store {partition.storeIndex}
                  </span>
                </div>
                <span className="font-mono text-ink-2">{fmt(partition.count)}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Typed Unit Economics outcomes" count={data.scope.denominator} />
          <PanelBody>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["FACT", economics.fact],
                ["ESTIMATE", economics.estimate],
                ["UNSOURCEABLE", economics.unsourceable],
                ["MISSING", economics.missing],
                ["INVALID", economics.invalid],
              ].map(([status, value]) => (
                <div key={String(status)} className="rounded-lg border border-rule px-2 py-2">
                  <StatusPill>{String(status)}</StatusPill>
                  <div className="mt-2 font-mono text-lg text-ink">{fmt(Number(value))}</div>
                </div>
              ))}
            </div>
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Immutable runtime bindings" />
        <PanelBody>
          <div className="grid gap-3 md:grid-cols-3">
            <Binding label="Read contract" value={data.readContractVersion} />
            <Binding label="Manifest SHA-256" value={data.authoritativeManifestSha256} />
            <Binding label="Database fingerprint" value={data.databaseTargetFingerprint} />
          </div>
        </PanelBody>
      </Panel>
    </>
  );
}

function ProductIdentity({ variant }: { variant: Variant }) {
  const name = [variant.brand, variant.productLine, variant.flavor]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-ink" title={name}>{name}</div>
      <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10.5px] text-ink-4">
        <span>{variant.form ?? "form unknown"}</span>
        <span>·</span>
        <span>
          {variant.size.amount} {variant.size.unit}
          {variant.size.outerPackCount > 1 ? ` × outer ${variant.size.outerPackCount}` : ""}
        </span>
      </div>
    </div>
  );
}

function ProductsView({
  data,
  searchDraft,
  onSearchDraft,
  onSubmitSearch,
  onClearSearch,
  onNext,
  onPrevious,
  hasPrevious,
}: {
  data: VariantsData;
  searchDraft: string;
  onSearchDraft: (value: string) => void;
  onSubmitSearch: (event: FormEvent) => void;
  onClearSearch: () => void;
  onNext: () => void;
  onPrevious: () => void;
  hasPrevious: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <>
      <form onSubmit={onSubmitSearch} className="flex flex-wrap gap-2">
        <label className="relative min-w-[260px] flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4"
          />
          <input
            value={searchDraft}
            onChange={(event) => onSearchDraft(event.target.value)}
            placeholder="Search exact brand, product line, flavor, or variant key…"
            className="w-full rounded-lg border border-rule bg-surface py-2 pl-8 pr-3 text-[12.5px] text-ink outline-none placeholder:text-ink-4"
          />
        </label>
        <Btn variant="default" type="submit">Search</Btn>
        {data.query ? (
          <Btn variant="ghost" type="button" onClick={onClearSearch}>Clear</Btn>
        ) : null}
      </form>

      <Panel>
        <PanelHeader
          title="Canonical product variants"
          count={data.variants.length}
          right={(
            <span className="text-[11px] text-ink-4">
              Retailer source rows alias these immutable identities
            </span>
          )}
        />
        {!data.variants.length ? (
          <div className="py-14 text-center text-[13px] text-ink-3">
            No canonical variants match this query.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-left font-mono text-[10px] uppercase tracking-wide text-ink-4">
                  <th className="px-4 py-2 font-medium">Canonical identity</th>
                  <th className="px-2 py-2 font-medium">Content</th>
                  <th className="px-2 py-2 font-medium">Sources</th>
                  <th className="px-2 py-2 font-medium">Offers</th>
                  <th className="px-4 py-2 font-medium">Variant key</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((variant) => {
                  const open = expanded === variant.canonicalVariantId;
                  const imageUrl = contentImage(variant.latestContent);
                  return (
                    <Fragment key={variant.canonicalVariantId}>
                      <tr
                        className={cn(
                          "cursor-pointer border-b border-rule/60 hover:bg-bg-elev/40",
                          open && "bg-bg-elev/30",
                        )}
                        onClick={() => setExpanded(open ? null : variant.canonicalVariantId)}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <ChevronRight
                              size={13}
                              className={cn(
                                "shrink-0 text-ink-4 transition",
                                open && "rotate-90",
                              )}
                            />
                            <div
                              className="h-10 w-10 shrink-0 rounded-lg border border-rule bg-bg-elev bg-contain bg-center bg-no-repeat"
                              style={imageUrl ? { backgroundImage: `url("${imageUrl}")` } : undefined}
                            />
                            <ProductIdentity variant={variant} />
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusPill>
                            {variant.latestContent ? "READY" : "MISSING"}
                          </StatusPill>
                          <div className="mt-1 text-[10.5px] text-ink-4">
                            {fmt(variant.contentObservationCount)} observations
                          </div>
                        </td>
                        <td className="px-2 py-2.5 font-mono text-ink-2">
                          {fmt(variant.sourceCount)}
                        </td>
                        <td className="px-2 py-2.5 font-mono text-ink-2">
                          {fmt(variant.offers.length)}
                        </td>
                        <td className="max-w-[230px] px-4 py-2.5">
                          <div
                            className="truncate font-mono text-[10.5px] text-ink-4"
                            title={variant.variantKey}
                          >
                            {variant.variantKey}
                          </div>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="border-b border-rule bg-bg-elev/20">
                          <td colSpan={5} className="px-4 py-4">
                            <VariantDetail variant={variant} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Pager
        hasPrevious={hasPrevious}
        hasNext={Boolean(data.nextCursor)}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    </>
  );
}

function VariantDetail({ variant }: { variant: Variant }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
      <div className="space-y-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Exact content observation
          </div>
          {variant.latestContent ? (
            <div className="mt-2 space-y-2 rounded-lg border border-rule bg-surface p-3">
              <div className="font-medium text-ink">
                {contentTitle(variant.latestContent) ?? "Untitled exact content"}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <Binding label="Source API" value={variant.latestContent.sourceApi} />
                <Binding label="Observed" value={localTime(variant.latestContent.observedAt)} />
                <Binding label="Content hash" value={variant.latestContent.contentHash} />
                <Binding
                  label="Run / approval"
                  value={`${variant.latestContent.runId ?? "unbound"} / ${variant.latestContent.approvalId ?? "unbound"}`}
                />
              </div>
              <a
                href={variant.latestContent.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-info hover:underline"
              >
                Open exact source <ExternalLink size={11} />
              </a>
            </div>
          ) : (
            <div className="mt-2 rounded-lg border border-danger/20 bg-danger-tint p-3 text-[12px] text-danger">
              No exact content observation. Price evidence must not fill this gap.
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Binding label="Identity hash" value={variant.identityHash} />
          <Binding label="Key version" value={variant.keyVersion} />
          <Binding label="Dimension" value={variant.size.dimension} />
          <Binding label="Modifiers" value={JSON.stringify(variant.modifiers)} />
        </div>
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Latest offer observations
        </div>
        {!variant.offers.length ? (
          <div className="mt-2 rounded-lg border border-rule p-4 text-[12px] text-ink-3">
            No canonical offer observation for this variant.
          </div>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border border-rule bg-surface">
            <table className="w-full text-[11.5px]">
              <thead>
                <tr className="border-b border-rule text-left text-[10px] uppercase tracking-wide text-ink-4">
                  <th className="px-3 py-2 font-medium">Retailer</th>
                  <th className="px-2 py-2 font-medium">Price</th>
                  <th className="px-2 py-2 font-medium">Locality</th>
                  <th className="px-2 py-2 font-medium">Stock</th>
                  <th className="px-3 py-2 font-medium">Observed</th>
                </tr>
              </thead>
              <tbody>
                {variant.offers.map((offer) => (
                  <tr key={offer.observationId} className="border-b border-rule/60 last:border-0">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="capitalize font-medium text-ink">{offer.retailer}</span>
                        {offer.isFirstParty ? <BadgeCheck size={12} className="text-green-ink" /> : null}
                        {offer.productUrl ? (
                          <a
                            href={offer.productUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="text-info"
                          >
                            <ExternalLink size={11} />
                          </a>
                        ) : null}
                      </div>
                      <div className="font-mono text-[9.5px] text-ink-4">
                        {offer.retailerProductId}
                      </div>
                    </td>
                    <td className="px-2 py-2 tabular text-ink">
                      {money(offer.price)}
                      {offer.pricePerUnit != null ? (
                        <div className="text-[9.5px] text-ink-4">
                          {money(offer.pricePerUnit)}/unit
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-ink-3">
                      {offer.zip ?? "—"}
                      <div className="text-[9.5px] text-ink-4">
                        {offer.localityEvidence ?? "unknown"}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <StatusPill>
                        {offer.inStock === true
                          ? "READY"
                          : offer.inStock === false
                            ? "BLOCKED"
                            : "UNKNOWN"}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-2 text-ink-3">
                      {localTime(offer.observedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Pager({
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <div className="flex justify-end gap-2">
      <Btn variant="default" onClick={onPrevious} disabled={!hasPrevious}>
        Previous
      </Btn>
      <Btn variant="default" onClick={onNext} disabled={!hasNext}>
        Next
      </Btn>
    </div>
  );
}

function ListingsShell({
  data,
  channel,
  storeIndex,
  onChannel,
  onStoreIndex,
  onPrevious,
  onNext,
  hasPrevious,
  children,
}: {
  data: ListingsData;
  channel: "amazon" | "walmart";
  storeIndex: number;
  onChannel: (channel: "amazon" | "walmart") => void;
  onStoreIndex: (storeIndex: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  children: ReactNode;
}) {
  const partitions = data.page.manifestInventory.partitions;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface p-2">
        <label className="text-[11px] font-medium text-ink-3">Partition</label>
        <select
          value={`${channel}:${storeIndex}`}
          onChange={(event) => {
            const [nextChannel, nextStore] = event.target.value.split(":");
            onChannel(nextChannel as "amazon" | "walmart");
            onStoreIndex(Number(nextStore));
          }}
          className="rounded-lg border border-rule bg-bg px-2.5 py-1.5 text-[12px] text-ink outline-none"
        >
          {partitions.map((partition) => (
            <option
              key={`${partition.channel}:${partition.storeIndex}`}
              value={`${partition.channel}:${partition.storeIndex}`}
            >
              {partition.channel} · store {partition.storeIndex} · {fmt(partition.scopeCount)}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-ink-4">
          Exact manifest scope · {fmt(data.page.manifestInventory.scopeCount)} listings
        </span>
      </div>
      {children}
      <Pager
        hasPrevious={hasPrevious}
        hasNext={Boolean(data.page.nextCursor)}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    </>
  );
}

function ComponentLine({ component }: { component: RecipeComponent }) {
  return (
    <div className="grid gap-2 border-b border-rule/50 py-2 last:border-0 sm:grid-cols-[1fr_auto_auto]">
      <div className="min-w-0">
        <div className="truncate font-medium text-ink">
          {component.content?.facts.title ?? component.product}
        </div>
        <div className="mt-0.5 truncate font-mono text-[9.5px] text-ink-4">
          {component.targetCanonicalVariantId}
        </div>
      </div>
      <span className="self-center font-mono text-ink-2">×{component.qty}</span>
      <div className="flex items-center gap-1.5 self-center">
        <StatusPill>{component.evidenceStatus}</StatusPill>
        <StatusPill>{component.content ? "READY" : "MISSING"}</StatusPill>
      </div>
    </div>
  );
}

function RecipesView({ data }: { data: ListingsData }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Panel>
      <PanelHeader
        title="Exact SKU recipes"
        count={data.snapshots.length}
        right={<span className="text-[11px] text-ink-4">listing scope → variant × quantity</span>}
      />
      {!data.snapshots.length ? (
        <div className="py-14 text-center text-[13px] text-ink-3">
          This manifest page is empty.
        </div>
      ) : (
        <div className="divide-y divide-rule">
          {data.snapshots.map((snapshot) => {
            const open = expanded === snapshot.snapshot.listingKey;
            return (
              <div key={snapshot.snapshot.listingKey}>
                <button
                  type="button"
                  className="grid w-full gap-3 px-4 py-3 text-left hover:bg-bg-elev/40 md:grid-cols-[1.2fr_1fr_auto]"
                  onClick={() => setExpanded(open ? null : snapshot.snapshot.listingKey)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ChevronRight
                      size={13}
                      className={cn("shrink-0 text-ink-4 transition", open && "rotate-90")}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[12px] text-ink">
                        {snapshot.snapshot.sku}
                      </div>
                      <div className="truncate font-mono text-[9.5px] text-ink-4">
                        {snapshot.snapshot.listingKey}
                      </div>
                    </div>
                  </div>
                  <div className="self-center text-[11.5px] text-ink-3">
                    {snapshot.recipe.components.length
                      ? `${snapshot.recipe.components.length} component${snapshot.recipe.components.length === 1 ? "" : "s"}`
                      : "No canonical recipe"}
                  </div>
                  <div className="flex items-center gap-1.5 self-center">
                    <StatusPill>
                      {snapshot.views.bundleFactory.ready ? "READY" : "BLOCKED"}
                    </StatusPill>
                  </div>
                </button>
                {open ? (
                  <div className="border-t border-rule/50 bg-bg-elev/20 px-8 py-3">
                    {snapshot.recipe.components.length ? (
                      snapshot.recipe.components.map((component) => (
                        <ComponentLine
                          key={component.componentEvidenceId}
                          component={component}
                        />
                      ))
                    ) : (
                      <Blockers blockers={snapshot.recipe.blockers} empty="No recipe evidence." />
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function Blockers({
  blockers,
  empty = "No blockers.",
}: {
  blockers: string[];
  empty?: string;
}) {
  if (!blockers.length) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-green-ink">
        <CheckCircle2 size={13} /> {empty}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {blockers.map((blocker) => (
        <span
          key={blocker}
          className="rounded border border-danger/15 bg-danger-tint px-1.5 py-0.5 font-mono text-[9.5px] text-danger"
        >
          {blocker}
        </span>
      ))}
    </div>
  );
}

function OffersView({ data }: { data: ListingsData }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Panel>
      <PanelHeader
        title="Typed COGS and procurement evidence"
        count={data.snapshots.length}
        right={<span className="text-[11px] text-ink-4">FACT ≠ ESTIMATE ≠ UNSOURCEABLE</span>}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-rule text-left font-mono text-[10px] uppercase tracking-wide text-ink-4">
              <th className="px-4 py-2 font-medium">Exact listing</th>
              <th className="px-2 py-2 font-medium">Outcome</th>
              <th className="px-2 py-2 text-right font-medium">Total COGS</th>
              <th className="px-2 py-2 text-right font-medium">Per unit</th>
              <th className="px-2 py-2 font-medium">Procurement</th>
              <th className="px-4 py-2 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {data.snapshots.map((snapshot) => {
              const economics = snapshot.views.unitEconomics;
              const current = economics.current;
              const open = expanded === snapshot.snapshot.listingKey;
              return (
                <Fragment key={snapshot.snapshot.listingKey}>
                  <tr
                    className={cn(
                      "cursor-pointer border-b border-rule/60 hover:bg-bg-elev/40",
                      open && "bg-bg-elev/30",
                    )}
                    onClick={() => setExpanded(open ? null : snapshot.snapshot.listingKey)}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <ChevronRight
                          size={12}
                          className={cn("text-ink-4 transition", open && "rotate-90")}
                        />
                        <div>
                          <div className="font-mono text-ink">{snapshot.snapshot.sku}</div>
                          <div className="font-mono text-[9.5px] text-ink-4">
                            {snapshot.snapshot.channel}:{snapshot.snapshot.storeIndex}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusPill>{economics.status}</StatusPill>
                    </td>
                    <td className="px-2 py-2.5 text-right font-medium tabular text-ink">
                      {money(current?.totalCost)}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular text-ink-3">
                      {money(current?.costPerUnit)}
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusPill>
                        {snapshot.views.procurement.ready ? "READY" : "BLOCKED"}
                      </StatusPill>
                    </td>
                    <td className="max-w-[180px] px-4 py-2.5">
                      <div className="truncate font-mono text-[9.5px] text-ink-4">
                        {current?.id ?? "no scoped cost"}
                      </div>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="border-b border-rule bg-bg-elev/20">
                      <td colSpan={6} className="px-6 py-4">
                        <CostDetail snapshot={snapshot} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CostDetail({ snapshot }: { snapshot: Snapshot }) {
  const economics = snapshot.views.unitEconomics;
  const cost = economics.current;
  return (
    <div className="grid gap-4 xl:grid-cols-[0.8fr_1.4fr]">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Scoped COGS observation
        </div>
        {cost ? (
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-rule bg-surface p-3">
            <Binding label="Outcome" value={cost.evidenceOutcome} />
            <Binding label="Effective" value={localTime(cost.effectiveDate)} />
            <Binding label="Product cost" value={money(cost.productCost)} />
            <Binding label="Packaging / ice" value={`${money(cost.packagingCost)} / ${money(cost.iceCost)}`} />
            <Binding label="Matcher" value={cost.matcherVersion} />
            <Binding label="Price policy" value={cost.pricePolicyVersion} />
            <Binding label="Run" value={cost.runId ?? "unbound"} />
            <Binding label="Approval" value={cost.approvalId ?? "unbound"} />
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-danger/20 bg-danger-tint p-3 text-[12px] text-danger">
            No current exact-scope COGS observation.
          </div>
        )}
        <div className="mt-3">
          <Blockers blockers={economics.blockers} />
        </div>
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Eligible procurement options
        </div>
        <div className="mt-2 space-y-2">
          {snapshot.views.procurement.components.map((component) => (
            <div key={component.componentIndex} className="rounded-lg border border-rule bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-ink">
                  {component.product} ×{component.requiredQuantity}
                </div>
                <span className="text-[10.5px] text-ink-4">
                  {component.factualOptions.length} fact · {component.estimateOptions.length} estimate
                </span>
              </div>
              {[...component.factualOptions, ...component.estimateOptions]
                .slice(0, 6)
                .map((option) => (
                  <div
                    key={option.observationId}
                    className="mt-2 grid gap-2 border-t border-rule/50 pt-2 sm:grid-cols-[1fr_auto_auto]"
                  >
                    <div>
                      <div className="flex items-center gap-1.5 capitalize text-ink">
                        {option.retailer}
                        <StatusPill>{option.eligibility}</StatusPill>
                        <a
                          href={option.productUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-info"
                        >
                          <ExternalLink size={11} />
                        </a>
                      </div>
                      <div className="text-[9.5px] text-ink-4">
                        {option.matchTier} · {option.locality.zip ?? option.locality.evidence}
                      </div>
                    </div>
                    <div className="self-center text-right tabular text-ink">
                      {money(option.packagePrice)}
                      <div className="text-[9.5px] text-ink-4">
                        {money(option.targetComparableUnitPrice)}/target
                      </div>
                    </div>
                    <div className="self-center text-right text-[10px] text-ink-4">
                      {localTime(option.freshness.observedAt)}
                    </div>
                  </div>
                ))}
              {!component.factualOptions.length && !component.estimateOptions.length ? (
                <div className="mt-2">
                  <Blockers blockers={component.blockers} empty="No eligible offer." />
                </div>
              ) : null}
            </div>
          ))}
          {!snapshot.views.procurement.components.length ? (
            <Blockers blockers={snapshot.views.procurement.blockers} empty="No procurement recipe." />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function OperationsView({ data }: { data: OperationsData }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <>
      <Panel>
        <PanelHeader
          title="Owner-gated operational workflow"
          right={<StatusPill>OFF</StatusPill>}
        />
        <PanelBody>
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["1", "Doctor", "SEALED CLI", "Read-only preflight"],
              ["2", "Plan", "SEALED CLI", "Immutable artifact"],
              ["3", "Owner Approval", "EXTERNAL", "Owner custody required"],
              ["4", "Execute", "OFF", "No UI execution grant"],
              ["5", "Status / Resume", "READ ONLY", "Resume stays disabled"],
              ["6", "Report", "READ ONLY", "Hashes shown below"],
            ].map(([ordinal, name, status, detail]) => (
              <div key={ordinal} className="rounded-lg border border-rule bg-bg-elev/35 p-2.5">
                <div className="font-mono text-[9.5px] text-ink-4">STEP {ordinal}</div>
                <div className="mt-1 text-[11.5px] font-semibold text-ink">{name}</div>
                <div className="mt-2"><StatusPill>{status}</StatusPill></div>
                <div className="mt-1.5 text-[9.5px] leading-relaxed text-ink-4">{detail}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-lg border border-danger/15 bg-danger-tint px-3 py-2 text-[11px] leading-relaxed text-ink-2">
            <span className="font-semibold text-danger">Activation blocker:</span>{" "}
            a durable command queue, immutable artifact custody, and a pinned owner
            authentication trust root do not yet exist for this web surface. A hash-only
            or self-asserted Approve button would not authenticate the owner.
          </div>
        </PanelBody>
      </Panel>
      <div className="rounded-xl border border-warn/25 bg-warn-tint px-4 py-3">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-warn-strong">
          <ShieldCheck size={15} />
          Read-only operational projection
        </div>
        <p className="mt-1 text-[11.5px] text-ink-2">
          This screen exposes sealed plans, queues, budgets, receipts, blockers,
          and artifact hashes. It intentionally has no Execute, retry, replay, or
          approval button in this phase.
        </p>
      </div>
      <Panel>
        <PanelHeader title="Sealed Product Truth runs" count={data.runs.length} />
        {!data.runs.length ? (
          <div className="py-14 text-center text-[13px] text-ink-3">
            No canonical operational runs are registered.
          </div>
        ) : (
          <div className="divide-y divide-rule">
            {data.runs.map((run) => {
              const open = expanded === run.runId;
              return (
                <div key={run.runId}>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : run.runId)}
                    className="grid w-full gap-3 px-4 py-3 text-left hover:bg-bg-elev/40 lg:grid-cols-[1fr_auto_auto_auto]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ChevronRight
                        size={13}
                        className={cn("text-ink-4 transition", open && "rotate-90")}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[11.5px] text-ink">
                          {run.runId}
                        </div>
                        <div className="truncate font-mono text-[9.5px] text-ink-4">
                          approval {run.approvalId}
                        </div>
                      </div>
                    </div>
                    <div className="self-center"><StatusPill>{run.status}</StatusPill></div>
                    <div className="self-center text-[11px] text-ink-3">
                      {run.mode} · {fmt(run.targetCount)} targets
                    </div>
                    <div className="self-center text-right text-[10.5px] text-ink-4">
                      {localTime(run.updatedAt)}
                    </div>
                  </button>
                  {open ? (
                    <div className="border-t border-rule/50 bg-bg-elev/20 px-6 py-4">
                      <RunDetail run={run} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}

function CountMap({ title, values }: { title: string; values: Record<string, number> }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-4">
        {title}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {Object.entries(values).length ? Object.entries(values).map(([key, value]) => (
          <span key={key} className="rounded border border-rule bg-surface px-1.5 py-0.5 text-[10px] text-ink-2">
            {key} · {fmt(value)}
          </span>
        )) : <span className="text-[11px] text-ink-4">none</span>}
      </div>
    </div>
  );
}

function RunDetail({ run }: { run: OperationsData["runs"][number] }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Binding label="Plan SHA" value={run.planSha256} />
        <Binding label="Manifest SHA" value={run.manifestSha256} />
        <Binding label="Event chain head" value={run.eventChainHead} />
        <Binding label="Report SHA" value={run.reportSha256 ?? "not sealed"} />
        <Binding label="Artifact index SHA" value={run.artifactIndexSha256 ?? "not sealed"} />
        <Binding label="Environment" value={run.environment} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <CountMap title="Run items" values={run.itemCounts} />
        <CountMap title="Queue jobs" values={run.queueCounts} />
      </div>
      <div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-ink-4">
          Metered provider budgets
        </div>
        {!run.budgets.length ? (
          <div className="mt-1 text-[11px] text-ink-4">No materialized budgets.</div>
        ) : (
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {run.budgets.map((budget) => (
              <div key={budget.provider} className="rounded-lg border border-rule bg-surface p-3">
                <div className="flex items-center justify-between">
                  <span className="capitalize font-medium text-ink">{budget.provider}</span>
                  <span className="font-mono text-[10px] text-ink-4">
                    {budget.reservedCalls}/{budget.maxCalls} calls
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-ink-4">
                  {budget.reservedUnits}/{budget.maxUnits ?? "∞"} units · expires {localTime(budget.expiresAt)}
                </div>
                <div className="mt-2"><CountMap title="Receipts" values={budget.receiptCounts} /></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-ink-4">
          Blockers / terminal gaps
        </div>
        {!run.blockers.length ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-green-ink">
            <CheckCircle2 size={12} /> No blocker rows in this projection.
          </div>
        ) : (
          <div className="mt-2 space-y-1.5">
            {run.blockers.map((blocker) => (
              <div
                key={`${blocker.listingKey}:${blocker.updatedAt}`}
                className="grid gap-2 rounded-lg border border-danger/15 bg-danger-tint px-3 py-2 text-[10.5px] md:grid-cols-[1fr_auto_auto]"
              >
                <span className="font-mono text-ink">{blocker.listingKey}</span>
                <StatusPill>{blocker.status}</StatusPill>
                <span className="text-ink-3">{blocker.stage} · {blocker.lastError ?? "no error text"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function allBlockers(snapshot: Snapshot): string[] {
  return [...new Set([
    ...snapshot.recipe.blockers,
    ...snapshot.views.bundleFactory.blockers,
    ...snapshot.views.listingImprovement.blockers,
    ...snapshot.views.unitEconomics.blockers,
    ...snapshot.views.procurement.blockers,
  ])].sort();
}

function QualityView({ data }: { data: ListingsData }) {
  const rows = data.snapshots.map((snapshot) => ({
    snapshot,
    blockers: allBlockers(snapshot),
  }));
  const blocked = rows.filter((row) => row.blockers.length > 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Page scopes"
          value={fmt(rows.length)}
          icon={<Boxes size={15} />}
        />
        <KpiCard
          label="With blockers"
          value={fmt(blocked.length)}
          icon={<AlertTriangle size={15} />}
          iconVariant={blocked.length ? "warn" : "default"}
        />
        <KpiCard
          label="Content ready"
          value={fmt(rows.filter((row) => row.snapshot.views.bundleFactory.ready).length)}
          icon={<Database size={15} />}
        />
        <KpiCard
          label="Procurement ready"
          value={fmt(rows.filter((row) => row.snapshot.views.procurement.ready).length)}
          icon={<Store size={15} />}
        />
      </div>
      <Panel>
        <PanelHeader
          title="Canonical blocker review"
          count={blocked.length}
          right={<span className="text-[11px] text-ink-4">Current page · no automated mutation</span>}
        />
        {!blocked.length ? (
          <div className="py-14 text-center text-[13px] text-green-ink">
            <CheckCircle2 size={20} className="mx-auto mb-2" />
            No blockers on this manifest page.
          </div>
        ) : (
          <div className="divide-y divide-rule">
            {blocked.map(({ snapshot, blockers }) => (
              <div key={snapshot.snapshot.listingKey} className="grid gap-2 px-4 py-3 md:grid-cols-[240px_1fr]">
                <div>
                  <div className="font-mono text-[11.5px] text-ink">{snapshot.snapshot.sku}</div>
                  <div className="font-mono text-[9px] text-ink-4">{snapshot.snapshot.listingKey}</div>
                </div>
                <Blockers blockers={blockers} />
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

function ReadinessView({ data }: { data: Overview }) {
  const denominator = data.scope.denominator;
  const economics = data.readiness.unitEconomics;
  const consumers = [
    {
      name: "Bundle Factory",
      purpose: "Create new channel listings and bundles from exact reusable content.",
      ready: data.readiness.bundleFactory.ready,
      blocked: data.readiness.bundleFactory.blocked,
      facts: `${fmt(data.catalog.variantsWithExactContent)} variants with exact content`,
    },
    {
      name: "Listing Improvement",
      purpose: "Improve existing listings without copying facts from a neighboring variant.",
      ready: data.readiness.listingImprovement.ready,
      blocked: data.readiness.listingImprovement.blocked,
      facts: `${fmt(data.catalog.contentObservations)} immutable content observations`,
    },
    {
      name: "Unit Economics",
      purpose: "Use typed current COGS: fact, honest estimate, or unsourceable.",
      ready: economics.ready,
      blocked: economics.blocked,
      facts: `${fmt(economics.fact)} fact · ${fmt(economics.estimate)} estimate · ${fmt(economics.unsourceable)} unsourceable`,
    },
    {
      name: "Procurement",
      purpose: "Choose fresh eligible first-party locality-bound buy options.",
      ready: data.readiness.procurement.ready,
      blocked: data.readiness.procurement.blocked,
      facts: `${fmt(data.catalog.localOfferObservations)} local/store-scoped offer observations`,
    },
  ];
  return (
    <>
      <div className="rounded-xl border border-info/20 bg-info-tint px-4 py-3">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-info">
          <Fingerprint size={15} />
          Data readiness is not consumer activation
        </div>
        <p className="mt-1 text-[11.5px] text-ink-2">
          These projections prove available canonical data only. SHADOW or ENFORCED
          cutover still requires a separate exact owner activation per consumer.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {consumers.map((consumer) => (
          <Panel key={consumer.name}>
            <PanelBody>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[14px] font-semibold text-ink">{consumer.name}</div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
                    {consumer.purpose}
                  </p>
                </div>
                <StatusPill>{consumer.blocked === 0 && denominator ? "READY" : "BLOCKED"}</StatusPill>
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular text-ink">
                  {readinessPercent(consumer.ready, denominator)}
                </span>
                <span className="text-[11.5px] text-ink-3">
                  {fmt(consumer.ready)} ready · {fmt(consumer.blocked)} blocked
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-elev">
                <div
                  className="h-full rounded-full bg-green"
                  style={{ width: denominator ? `${(consumer.ready / denominator) * 100}%` : "0%" }}
                />
              </div>
              <div className="mt-3 text-[10.5px] text-ink-4">{consumer.facts}</div>
            </PanelBody>
          </Panel>
        ))}
      </div>
      <Panel>
        <PanelHeader title="Readiness proof boundary" />
        <PanelBody>
          <div className="grid gap-3 md:grid-cols-3">
            <Binding label="Denominator" value={`${fmt(denominator)} exact listing scopes`} />
            <Binding label="Manifest" value={data.authoritativeManifestSha256} />
            <Binding label="Database target" value={data.databaseTargetFingerprint} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[10.5px] text-ink-3">
            <span className="flex items-center gap-1"><CheckCircle2 size={11} /> no writes</span>
            <span className="flex items-center gap-1"><CheckCircle2 size={11} /> no paid calls</span>
            <span className="flex items-center gap-1"><CheckCircle2 size={11} /> no legacy fallback</span>
            <span className="flex items-center gap-1"><Clock3 size={11} /> as of {localTime(data.readAt)}</span>
          </div>
        </PanelBody>
      </Panel>
    </>
  );
}
