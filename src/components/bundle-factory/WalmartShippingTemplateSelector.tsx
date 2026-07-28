"use client";

import { useEffect, useState } from "react";
import { Info, Loader2, Truck, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface WalmartAccountOption {
  store_index: number;
  name: string;
}

interface WalmartTemplateOption {
  id: string;
  name: string;
  type: string;
  status: "ACTIVE" | "INACTIVE";
  rate_model_type: "TIERED_PRICING" | "PER_SHIPMENT_PRICING";
  modified_at: string | null;
}

interface Money {
  amount_cents: number;
  currency: string;
}

interface TemplateConfiguration {
  configuration_id: string;
  ship_method: string;
  status: "ACTIVE" | "INACTIVE";
  transit_time_days: number;
  address_types: string[];
  region_codes: string[];
  region_names: string[];
  state_codes: string[];
  pricing:
    | {
        kind: "PER_SHIPMENT_PRICING";
        unit_of_measure: "LB" | "OZ";
        shipping_and_handling: Money;
        charge_per_weight: Money;
        charge_per_item: Money;
      }
    | {
        kind: "TIERED_PRICING";
        tiers: Array<{
          min_limit_cents: number;
          max_limit_cents: number | null;
          ship_charge: Money;
        }>;
      };
}

interface WalmartTemplateDetails extends WalmartTemplateOption {
  shipping_type: string | null;
  created_at: string | null;
  configurations: TemplateConfiguration[];
  is_free_shipping: boolean;
  template_sha256: string;
}

export interface WalmartShippingSelection {
  store_index: number;
  account_name: string;
  template_id: string;
  template_name: string;
  template_status: "ACTIVE" | "INACTIVE";
  rate_model_type: "TIERED_PRICING" | "PER_SHIPMENT_PRICING";
  is_free_shipping: boolean;
  template_sha256: string;
  template_modified_at: string | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pricingLabel(configuration: TemplateConfiguration): string {
  if (configuration.pricing.kind === "PER_SHIPMENT_PRICING") {
    const pricing = configuration.pricing;
    const parts = [
      `${money(pricing.shipping_and_handling.amount_cents)} base`,
    ];
    if (pricing.charge_per_weight.amount_cents > 0) {
      parts.push(
        `${money(pricing.charge_per_weight.amount_cents)}` +
          `/${pricing.unit_of_measure.toLowerCase()}`,
      );
    }
    if (pricing.charge_per_item.amount_cents > 0) {
      parts.push(`${money(pricing.charge_per_item.amount_cents)}/item`);
    }
    return parts.join(" + ");
  }
  return configuration.pricing.tiers.map((tier) => {
    const range = tier.max_limit_cents == null
      ? `${money(tier.min_limit_cents)}+`
      : `${money(tier.min_limit_cents)}–${money(tier.max_limit_cents)}`;
    return `${range}: ${money(tier.ship_charge.amount_cents)}`;
  }).join(" · ");
}

export function WalmartShippingTemplateSelector({
  value,
  onChange,
}: {
  value: WalmartShippingSelection | null;
  onChange: (selection: WalmartShippingSelection | null) => void;
}) {
  const [accounts, setAccounts] = useState<WalmartAccountOption[]>([]);
  const [storeIndex, setStoreIndex] = useState<number | null>(
    value?.store_index ?? null,
  );
  const [templates, setTemplates] = useState<WalmartTemplateOption[]>([]);
  const [templateId, setTemplateId] = useState(value?.template_id ?? "");
  const [details, setDetails] = useState<WalmartTemplateDetails | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadAccounts() {
      setAccountsLoading(true);
      setError(null);
      try {
        const response = await fetch(
          "/api/bundle-factory/walmart/accounts",
          { cache: "no-store" },
        );
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body?.error ?? "Failed to load Walmart accounts");
        }
        const nextAccounts = (body.accounts ?? []) as WalmartAccountOption[];
        if (cancelled) return;
        setAccounts(nextAccounts);
        setStoreIndex((current) =>
          current ?? nextAccounts[0]?.store_index ?? null
        );
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to load Walmart accounts",
          );
        }
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    }
    void loadAccounts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (storeIndex == null) {
      setTemplates([]);
      setTemplateId("");
      setDetails(null);
      onChange(null);
      return;
    }
    let cancelled = false;
    async function loadTemplates() {
      setTemplatesLoading(true);
      setError(null);
      setTemplates([]);
      setTemplateId("");
      setDetails(null);
      onChange(null);
      try {
        const response = await fetch(
          `/api/bundle-factory/walmart/shipping-templates?storeIndex=${storeIndex}`,
          { cache: "no-store" },
        );
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body?.detail ?? body?.error ?? "Failed to load shipping templates",
          );
        }
        if (!cancelled) {
          setTemplates((body.templates ?? []) as WalmartTemplateOption[]);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to load shipping templates",
          );
        }
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    }
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [storeIndex, onChange]);

  useEffect(() => {
    if (storeIndex == null || !templateId) {
      setDetails(null);
      onChange(null);
      return;
    }
    const selectedStoreIndex = storeIndex;
    let cancelled = false;
    async function loadDetails() {
      setDetailsLoading(true);
      setError(null);
      setDetails(null);
      onChange(null);
      try {
        const response = await fetch(
          `/api/bundle-factory/walmart/shipping-templates?storeIndex=${selectedStoreIndex}` +
            `&templateId=${encodeURIComponent(templateId)}`,
          { cache: "no-store" },
        );
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body?.detail ?? body?.error ?? "Failed to load template settings",
          );
        }
        const template = body.template as WalmartTemplateDetails;
        if (cancelled) return;
        setDetails(template);
        const accountName =
          accounts.find(
            (account) => account.store_index === selectedStoreIndex
          )?.name ?? `Walmart account ${selectedStoreIndex}`;
        onChange({
          store_index: selectedStoreIndex,
          account_name: accountName,
          template_id: template.id,
          template_name: template.name,
          template_status: template.status,
          rate_model_type: template.rate_model_type,
          is_free_shipping: template.is_free_shipping,
          template_sha256: template.template_sha256,
          template_modified_at: template.modified_at,
        });
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to load template settings",
          );
        }
      } finally {
        if (!cancelled) setDetailsLoading(false);
      }
    }
    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [accounts, storeIndex, templateId, onChange]);

  const active = details?.status === "ACTIVE";

  return (
    <div className="rounded-[12px] border border-blue-200 bg-blue-50/50 p-3.5">
      <div className="flex items-start gap-2.5">
        <Truck size={17} strokeWidth={1.8} className="mt-0.5 shrink-0 text-blue-700" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">
            Walmart shipping
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
            Choose the Walmart account first, then the exact live shipping
            template. The selected rate is included in listing economics.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11.5px] font-medium text-ink-2">
            Walmart account
          </span>
          <select
            value={storeIndex ?? ""}
            disabled={accountsLoading || accounts.length === 0}
            onChange={(event) =>
              setStoreIndex(event.target.value
                ? Number(event.target.value)
                : null)
            }
            className="mt-1.5 w-full rounded-[10px] border border-rule bg-surface px-3 py-2.5 text-[13px] text-ink outline-none focus:border-silver-line disabled:opacity-60"
          >
            <option value="">
              {accountsLoading ? "Loading accounts…" : "Select account"}
            </option>
            {accounts.map((account) => (
              <option key={account.store_index} value={account.store_index}>
                {account.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[11.5px] font-medium text-ink-2">
            Shipping template
          </span>
          <select
            value={templateId}
            disabled={storeIndex == null || templatesLoading}
            onChange={(event) => setTemplateId(event.target.value)}
            className="mt-1.5 w-full rounded-[10px] border border-rule bg-surface px-3 py-2.5 text-[13px] text-ink outline-none focus:border-silver-line disabled:opacity-60"
          >
            <option value="">
              {templatesLoading ? "Loading templates…" : "Select template"}
            </option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
                {template.status === "INACTIVE" ? " · inactive" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {detailsLoading && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
          <Loader2 size={14} className="animate-spin" />
          Reading exact rates and regions…
        </div>
      )}

      {details && (
        <div
          className={cn(
            "mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border px-3 py-2.5",
            active
              ? "border-blue-200 bg-white"
              : "border-warn/30 bg-warn-tint",
          )}
        >
          <div className="text-[12px] text-ink-2">
            <span className="font-semibold">{details.name}</span>
            <span className="text-ink-3">
              {" · "}
              {details.is_free_shipping
                ? "Free shipping"
                : details.rate_model_type === "TIERED_PRICING"
                  ? "Tiered customer shipping"
                  : "Per-shipment customer shipping"}
              {" · "}
              {details.configurations.length} rate scenario
              {details.configurations.length === 1 ? "" : "s"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-blue-700 hover:text-blue-900"
          >
            <Info size={13} />
            View settings
          </button>
        </div>
      )}

      {details?.status === "INACTIVE" && (
        <p className="mt-2 text-[11.5px] text-warn-strong">
          This template can be reviewed, but it cannot be used for a new
          listing until it is active in Walmart.
        </p>
      )}
      {accounts.length === 0 && !accountsLoading && !error && (
        <p className="mt-2 text-[11.5px] text-warn-strong">
          No configured Walmart account was found.
        </p>
      )}
      {error && (
        <p className="mt-2 text-[11.5px] text-danger">{error}</p>
      )}

      {modalOpen && details && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="walmart-shipping-template-title"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setModalOpen(false);
          }}
        >
          <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-[16px] border border-rule bg-surface shadow-xl">
            <div className="sticky top-0 flex items-start justify-between gap-4 border-b border-rule bg-surface px-5 py-4">
              <div>
                <h2
                  id="walmart-shipping-template-title"
                  className="text-[16px] font-semibold text-ink"
                >
                  {details.name}
                </h2>
                <p className="mt-1 text-[11.5px] text-ink-3">
                  Template {details.id} · {details.type} · {details.status} ·{" "}
                  {details.rate_model_type}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setModalOpen(false)}
                className="rounded-md p-1 text-ink-3 hover:bg-bg-elev hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 p-5">
              <div className="rounded-[10px] border border-rule bg-surface-tint px-3 py-2.5 text-[12px] text-ink-2">
                Customer shipping:{" "}
                <span className="font-semibold">
                  {details.is_free_shipping
                    ? "$0.00 — free shipping"
                    : "calculated from the scenarios below"}
                </span>
              </div>
              {details.configurations.map((configuration) => (
                <div
                  key={configuration.configuration_id}
                  className="rounded-[12px] border border-rule p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[13px] font-semibold text-ink">
                      {configuration.ship_method}
                    </div>
                    <div className="text-[11.5px] text-ink-3">
                      {configuration.transit_time_days} transit day
                      {configuration.transit_time_days === 1 ? "" : "s"} ·{" "}
                      {configuration.status}
                    </div>
                  </div>
                  <dl className="mt-3 grid gap-2 text-[11.5px] sm:grid-cols-2">
                    <div>
                      <dt className="text-ink-4">Customer charge</dt>
                      <dd className="mt-0.5 font-medium text-ink-2">
                        {pricingLabel(configuration)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-4">Address types</dt>
                      <dd className="mt-0.5 text-ink-2">
                        {configuration.address_types.join(", ")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-4">Regions</dt>
                      <dd className="mt-0.5 text-ink-2">
                        {configuration.region_names.join(", ") ||
                          configuration.region_codes.join(", ")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-4">States</dt>
                      <dd className="mt-0.5 text-ink-2">
                        {configuration.state_codes.length > 0
                          ? configuration.state_codes.join(", ")
                          : "Defined by Walmart region"}
                      </dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
