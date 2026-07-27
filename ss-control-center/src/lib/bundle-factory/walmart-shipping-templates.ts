import { createHash } from "node:crypto";

export type WalmartShippingTemplateRateModel =
  | "TIERED_PRICING"
  | "PER_SHIPMENT_PRICING";

export interface WalmartShippingTemplateSummary {
  id: string;
  name: string;
  type: string;
  status: "ACTIVE" | "INACTIVE";
  rate_model_type: WalmartShippingTemplateRateModel;
  shipping_type: string | null;
  created_at: string | null;
  modified_at: string | null;
}

export interface WalmartShippingMoney {
  amount_cents: number;
  currency: string;
}

export interface WalmartPerShipmentPricing {
  kind: "PER_SHIPMENT_PRICING";
  unit_of_measure: "LB" | "OZ";
  shipping_and_handling: WalmartShippingMoney;
  charge_per_weight: WalmartShippingMoney;
  charge_per_item: WalmartShippingMoney;
}

export interface WalmartTieredShippingCharge {
  min_limit_cents: number;
  max_limit_cents: number | null;
  ship_charge: WalmartShippingMoney;
}

export interface WalmartTieredPricing {
  kind: "TIERED_PRICING";
  tiers: WalmartTieredShippingCharge[];
}

export interface WalmartShippingTemplateConfiguration {
  configuration_id: string;
  ship_method: string;
  status: "ACTIVE" | "INACTIVE";
  transit_time_days: number;
  address_types: string[];
  region_codes: string[];
  region_names: string[];
  state_codes: string[];
  pricing: WalmartPerShipmentPricing | WalmartTieredPricing;
}

export interface WalmartShippingTemplateDetails
  extends WalmartShippingTemplateSummary {
  configurations: WalmartShippingTemplateConfiguration[];
  is_free_shipping: boolean;
  template_sha256: string;
}

export interface WalmartShippingChargeScenario {
  scenario_id: string;
  ship_method: string;
  transit_time_days: number;
  address_types: string[];
  region_codes: string[];
  region_names: string[];
  state_codes: string[];
  customer_shipping_charge_cents: number;
  currency: string;
}

export class WalmartShippingTemplateContractError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Walmart shipping template: ${issues.join("; ")}`);
    this.name = "WalmartShippingTemplateContractError";
    this.issues = issues;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(
  value: unknown,
  path: string,
  issues: string[],
): string {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path} is required`);
    return "";
  }
  return value.trim();
}

function enumStatus(
  value: unknown,
  path: string,
  issues: string[],
): "ACTIVE" | "INACTIVE" {
  if (value === "ACTIVE" || value === "INACTIVE") return value;
  issues.push(`${path} must be ACTIVE or INACTIVE`);
  return "INACTIVE";
}

function rateModel(
  value: unknown,
  path: string,
  issues: string[],
): WalmartShippingTemplateRateModel {
  if (value === "TIERED_PRICING" || value === "PER_SHIPMENT_PRICING") {
    return value;
  }
  issues.push(`${path} is unsupported`);
  return "PER_SHIPMENT_PRICING";
}

function canonicalIsoFromEpoch(value: unknown, path: string, issues: string[]) {
  if (value == null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    issues.push(`${path} must be a positive epoch millisecond value`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    issues.push(`${path} is not a valid timestamp`);
    return null;
  }
  return date.toISOString();
}

function money(
  value: unknown,
  path: string,
  issues: string[],
): WalmartShippingMoney {
  const raw = record(value);
  const amount = raw?.amount;
  const currency = raw?.currency;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    issues.push(`${path}.amount must be a non-negative number`);
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    issues.push(`${path}.currency must be an ISO currency code`);
  }
  const amountCents =
    typeof amount === "number" && Number.isFinite(amount) && amount >= 0
      ? Math.round((amount + Number.EPSILON) * 100)
      : 0;
  if (!Number.isSafeInteger(amountCents)) {
    issues.push(`${path}.amount exceeds safe cents precision`);
  }
  return {
    amount_cents: amountCents,
    currency: typeof currency === "string" ? currency : "",
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
}

function collectCoverage(regionsValue: unknown): {
  regionCodes: string[];
  regionNames: string[];
  stateCodes: string[];
} {
  const regionCodes: string[] = [];
  const regionNames: string[] = [];
  const stateCodes: string[] = [];
  const regions = Array.isArray(regionsValue) ? regionsValue : [];
  for (const regionValue of regions) {
    const region = record(regionValue);
    if (!region) continue;
    if (typeof region.regionCode === "string") {
      regionCodes.push(region.regionCode.trim());
    }
    if (typeof region.regionName === "string") {
      regionNames.push(region.regionName.trim());
    }
    const directStates = Array.isArray(region.states) ? region.states : [];
    for (const stateValue of directStates) {
      const state = record(stateValue);
      if (typeof state?.stateCode === "string") {
        stateCodes.push(state.stateCode.trim());
      }
    }
    const subRegions = Array.isArray(region.subRegions)
      ? region.subRegions
      : [];
    for (const subRegionValue of subRegions) {
      const subRegion = record(subRegionValue);
      const states = Array.isArray(subRegion?.states)
        ? subRegion.states
        : [];
      for (const stateValue of states) {
        const state = record(stateValue);
        if (typeof state?.stateCode === "string") {
          stateCodes.push(state.stateCode.trim());
        }
      }
    }
  }
  return {
    regionCodes: sortedUnique(regionCodes),
    regionNames: sortedUnique(regionNames),
    stateCodes: sortedUnique(stateCodes),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function parseSummary(
  value: unknown,
  path: string,
  issues: string[],
): WalmartShippingTemplateSummary {
  const raw = record(value);
  if (!raw) issues.push(`${path} must be an object`);
  const rateModelType = rateModel(
    raw?.rateModelType,
    `${path}.rateModelType`,
    issues,
  );
  return {
    id: requiredText(raw?.id, `${path}.id`, issues),
    name: requiredText(raw?.name, `${path}.name`, issues),
    type: requiredText(raw?.type, `${path}.type`, issues),
    status: enumStatus(raw?.status, `${path}.status`, issues),
    rate_model_type: rateModelType,
    shipping_type:
      typeof raw?.shippingType === "string" && raw.shippingType.trim()
        ? raw.shippingType.trim()
        : null,
    created_at: canonicalIsoFromEpoch(
      raw?.createdDate,
      `${path}.createdDate`,
      issues,
    ),
    modified_at: canonicalIsoFromEpoch(
      raw?.modifiedDate,
      `${path}.modifiedDate`,
      issues,
    ),
  };
}

export function parseWalmartShippingTemplateList(
  value: unknown,
): WalmartShippingTemplateSummary[] {
  const issues: string[] = [];
  const root = record(value);
  const rows = root?.shippingTemplates;
  if (!Array.isArray(rows)) {
    throw new WalmartShippingTemplateContractError([
      "shippingTemplates must be an array",
    ]);
  }
  const templates = rows.map((row, index) =>
    parseSummary(row, `shippingTemplates[${index}]`, issues),
  );
  const ids = new Set<string>();
  for (const template of templates) {
    if (ids.has(template.id)) {
      issues.push(`duplicate shipping template id ${template.id}`);
    }
    ids.add(template.id);
  }
  if (issues.length > 0) {
    throw new WalmartShippingTemplateContractError(issues);
  }
  return templates.sort((left, right) => {
    const activeDifference =
      Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE");
    return activeDifference || left.name.localeCompare(right.name, "en-US");
  });
}

export function parseWalmartShippingTemplateDetails(
  value: unknown,
): WalmartShippingTemplateDetails {
  const issues: string[] = [];
  const root = record(value);
  const summary = parseSummary(root, "template", issues);
  const methods = root?.shippingMethods;
  if (!Array.isArray(methods) || methods.length === 0) {
    issues.push("template.shippingMethods must be a non-empty array");
  }
  const configurations: WalmartShippingTemplateConfiguration[] = [];
  for (const [methodIndex, methodValue] of (
    Array.isArray(methods) ? methods : []
  ).entries()) {
    const method = record(methodValue);
    const shipMethod = requiredText(
      method?.shipMethod,
      `template.shippingMethods[${methodIndex}].shipMethod`,
      issues,
    );
    const methodStatus = enumStatus(
      method?.status,
      `template.shippingMethods[${methodIndex}].status`,
      issues,
    );
    const rawConfigurations = method?.configurations;
    if (!Array.isArray(rawConfigurations) || rawConfigurations.length === 0) {
      issues.push(
        `template.shippingMethods[${methodIndex}].configurations must be non-empty`,
      );
      continue;
    }
    for (const [configurationIndex, configurationValue] of (
      rawConfigurations
    ).entries()) {
      const path =
        `template.shippingMethods[${methodIndex}].configurations[${configurationIndex}]`;
      const configuration = record(configurationValue);
      if (!configuration) {
        issues.push(`${path} must be an object`);
        continue;
      }
      const transitTime = configuration.transitTime;
      if (
        !Number.isSafeInteger(transitTime) ||
        Number(transitTime) <= 0
      ) {
        issues.push(`${path}.transitTime must be a positive integer`);
      }
      const addressTypes = Array.isArray(configuration.addressTypes)
        ? configuration.addressTypes.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        ).map((entry) => entry.trim())
        : [];
      if (addressTypes.length === 0) {
        issues.push(`${path}.addressTypes must be non-empty`);
      }
      const coverage = collectCoverage(configuration.regions);
      if (
        coverage.regionCodes.length === 0 &&
        coverage.regionNames.length === 0 &&
        coverage.stateCodes.length === 0
      ) {
        issues.push(`${path}.regions must define coverage`);
      }
      let pricing: WalmartPerShipmentPricing | WalmartTieredPricing;
      if (summary.rate_model_type === "PER_SHIPMENT_PRICING") {
        const perShipment = record(configuration.perShippingCharge);
        const unitOfMeasure = perShipment?.unitOfMeasure;
        if (unitOfMeasure !== "LB" && unitOfMeasure !== "OZ") {
          issues.push(`${path}.perShippingCharge.unitOfMeasure is unsupported`);
        }
        const shippingAndHandling = money(
          perShipment?.shippingAndHandling,
          `${path}.perShippingCharge.shippingAndHandling`,
          issues,
        );
        const hasChargePerWeight =
          perShipment?.chargePerWeight !== undefined &&
          perShipment?.chargePerWeight !== null;
        const hasChargePerItem =
          perShipment?.chargePerItem !== undefined &&
          perShipment?.chargePerItem !== null;
        if (!hasChargePerWeight && !hasChargePerItem) {
          issues.push(
            `${path}.perShippingCharge must define chargePerWeight or chargePerItem`,
          );
        }
        // Walmart omits the unused variable charge instead of returning an
        // explicit zero. Preserve a complete deterministic pricing model by
        // normalizing only that omitted counterpart to zero in the fixed
        // charge currency. A response that omits both variable charges still
        // fails closed above.
        const chargePerWeight = hasChargePerWeight
          ? money(
            perShipment?.chargePerWeight,
            `${path}.perShippingCharge.chargePerWeight`,
            issues,
          )
          : {
            amount_cents: 0,
            currency: shippingAndHandling.currency,
          };
        const chargePerItem = hasChargePerItem
          ? money(
            perShipment?.chargePerItem,
            `${path}.perShippingCharge.chargePerItem`,
            issues,
          )
          : {
            amount_cents: 0,
            currency: shippingAndHandling.currency,
          };
        pricing = {
          kind: "PER_SHIPMENT_PRICING",
          unit_of_measure:
            unitOfMeasure === "OZ" ? "OZ" : "LB",
          shipping_and_handling: shippingAndHandling,
          charge_per_weight: chargePerWeight,
          charge_per_item: chargePerItem,
        };
      } else {
        const tiersValue = configuration.tieredShippingCharges;
        if (!Array.isArray(tiersValue) || tiersValue.length === 0) {
          issues.push(`${path}.tieredShippingCharges must be non-empty`);
        }
        const tiers = (Array.isArray(tiersValue) ? tiersValue : []).map(
          (tierValue, tierIndex) => {
            const tier = record(tierValue);
            const tierPath = `${path}.tieredShippingCharges[${tierIndex}]`;
            const minLimit = tier?.minLimit;
            const maxLimit = tier?.maxLimit;
            if (
              typeof minLimit !== "number" ||
              !Number.isFinite(minLimit) ||
              minLimit < 0
            ) {
              issues.push(`${tierPath}.minLimit must be non-negative`);
            }
            if (
              typeof maxLimit !== "number" ||
              !Number.isFinite(maxLimit) ||
              (maxLimit < 0 && maxLimit !== -1)
            ) {
              issues.push(`${tierPath}.maxLimit must be -1 or non-negative`);
            }
            const minLimitCents =
              typeof minLimit === "number" && Number.isFinite(minLimit)
                ? Math.round((minLimit + Number.EPSILON) * 100)
                : 0;
            const maxLimitCents =
              maxLimit === -1
                ? null
                : typeof maxLimit === "number" && Number.isFinite(maxLimit)
                  ? Math.round((maxLimit + Number.EPSILON) * 100)
                  : 0;
            if (
              maxLimitCents != null &&
              maxLimitCents < minLimitCents
            ) {
              issues.push(`${tierPath} has maxLimit below minLimit`);
            }
            return {
              min_limit_cents: minLimitCents,
              max_limit_cents: maxLimitCents,
              ship_charge: money(
                tier?.shipCharge,
                `${tierPath}.shipCharge`,
                issues,
              ),
            };
          },
        ).sort((left, right) =>
          left.min_limit_cents - right.min_limit_cents
        );
        pricing = {
          kind: "TIERED_PRICING",
          tiers,
        };
      }
      configurations.push({
        configuration_id:
          `${shipMethod}:${methodIndex}:${configurationIndex}`,
        ship_method: shipMethod,
        status: methodStatus,
        transit_time_days:
          Number.isSafeInteger(transitTime) ? Number(transitTime) : 0,
        address_types: sortedUnique(addressTypes),
        region_codes: coverage.regionCodes,
        region_names: coverage.regionNames,
        state_codes: coverage.stateCodes,
        pricing,
      });
    }
  }
  if (
    summary.status === "ACTIVE" &&
    configurations.every((configuration) => configuration.status !== "ACTIVE")
  ) {
    issues.push("active template has no active shipping configuration");
  }
  if (issues.length > 0) {
    throw new WalmartShippingTemplateContractError(issues);
  }
  const isFreeShipping = configurations
    .filter((configuration) => configuration.status === "ACTIVE")
    .every((configuration) => {
      if (configuration.pricing.kind === "PER_SHIPMENT_PRICING") {
        return (
          configuration.pricing.shipping_and_handling.amount_cents === 0 &&
          configuration.pricing.charge_per_weight.amount_cents === 0 &&
          configuration.pricing.charge_per_item.amount_cents === 0
        );
      }
      return configuration.pricing.tiers.every(
        (tier) => tier.ship_charge.amount_cents === 0,
      );
    });
  const detailsWithoutHash = {
    ...summary,
    configurations,
    is_free_shipping: isFreeShipping,
  };
  return {
    ...detailsWithoutHash,
    template_sha256: sha256(detailsWithoutHash),
  };
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WalmartShippingTemplateContractError([
      `${label} must be a positive safe integer`,
    ]);
  }
  return value;
}

function configurationCharge(
  configuration: WalmartShippingTemplateConfiguration,
  input: {
    itemPriceCents: number;
    packageWeightOz: number;
    itemQuantity: number;
  },
): { amountCents: number; currency: string } {
  const pricing = configuration.pricing;
  if (pricing.kind === "PER_SHIPMENT_PRICING") {
    if (!Number.isFinite(input.packageWeightOz) || input.packageWeightOz <= 0) {
      throw new WalmartShippingTemplateContractError([
        "packageWeightOz must be positive for per-shipment pricing",
      ]);
    }
    const units =
      pricing.unit_of_measure === "LB"
        ? input.packageWeightOz / 16
        : input.packageWeightOz;
    const currencies = new Set([
      pricing.shipping_and_handling.currency,
      pricing.charge_per_weight.currency,
      pricing.charge_per_item.currency,
    ]);
    if (currencies.size !== 1) {
      throw new WalmartShippingTemplateContractError([
        `${configuration.configuration_id} mixes currencies`,
      ]);
    }
    return {
      amountCents: Math.round(
        pricing.shipping_and_handling.amount_cents +
        pricing.charge_per_weight.amount_cents * units +
        pricing.charge_per_item.amount_cents * input.itemQuantity,
      ),
      currency: pricing.shipping_and_handling.currency,
    };
  }
  const matchingTiers = pricing.tiers.filter((tier) =>
    input.itemPriceCents >= tier.min_limit_cents &&
    (tier.max_limit_cents == null ||
      input.itemPriceCents <= tier.max_limit_cents)
  );
  if (matchingTiers.length !== 1) {
    throw new WalmartShippingTemplateContractError([
      `${configuration.configuration_id} has ${matchingTiers.length} matching tiers for item price`,
    ]);
  }
  return {
    amountCents: matchingTiers[0]!.ship_charge.amount_cents,
    currency: matchingTiers[0]!.ship_charge.currency,
  };
}

export function calculateWalmartTemplateShippingScenarios(input: {
  template: WalmartShippingTemplateDetails;
  itemPriceCents: number;
  packageWeightOz: number;
  itemQuantity?: number;
}): WalmartShippingChargeScenario[] {
  if (input.template.status !== "ACTIVE") {
    throw new WalmartShippingTemplateContractError([
      `shipping template ${input.template.id} is not ACTIVE`,
    ]);
  }
  const itemPriceCents = positiveSafeInteger(
    input.itemPriceCents,
    "itemPriceCents",
  );
  const itemQuantity = positiveSafeInteger(
    input.itemQuantity ?? 1,
    "itemQuantity",
  );
  const active = input.template.configurations.filter(
    (configuration) => configuration.status === "ACTIVE",
  );
  if (active.length === 0) {
    throw new WalmartShippingTemplateContractError([
      `shipping template ${input.template.id} has no active configurations`,
    ]);
  }
  return active.map((configuration) => {
    const charge = configurationCharge(configuration, {
      itemPriceCents,
      packageWeightOz: input.packageWeightOz,
      itemQuantity,
    });
    return {
      scenario_id: configuration.configuration_id,
      ship_method: configuration.ship_method,
      transit_time_days: configuration.transit_time_days,
      address_types: configuration.address_types,
      region_codes: configuration.region_codes,
      region_names: configuration.region_names,
      state_codes: configuration.state_codes,
      customer_shipping_charge_cents: charge.amountCents,
      currency: charge.currency,
    };
  });
}
