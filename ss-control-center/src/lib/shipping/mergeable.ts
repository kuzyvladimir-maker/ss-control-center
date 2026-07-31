// Merge Orders detection — Path A (deep-link to Veeqo for the actual
// merge click). We compute a normalised "delivery signature" per order
// and any two orders within the same channel + store with the same
// signature are flagged as mergeable. We don't try to invent fuzzy
// address matching; if Veeqo flags more pairs than us, we tighten the
// normalisation later to match.
//
// See docs/wiki/merge-orders-design.md for the full design rationale.

// Loose Veeqo order shape we depend on. We accept whatever shape Veeqo
// returns and only read the fields we need — the rest can vary.
interface VeeqoOrderForMerge {
  id?: number | string;
  number?: string;
  // Veeqo's OWN address fingerprint (64-hex). Note the spelling: their field
  // is `mergable_checksum`, missing the second "e". Two orders Veeqo considers
  // mergeable carry an identical checksum — verified 2026-07-31 on merged
  // order #P-1988529619, where the merged parent and both originals all shared
  // `a65dd118…153d90`.
  mergable_checksum?: string | null;
  // Set on an original order once it has been merged: the id of the combined
  // order that now owns its fulfilment. Non-null means "already merged".
  merged_to_id?: number | string | null;
  // True on the combined order itself (channel `direct` / "Merged Orders",
  // numbered `#P-<id>`).
  merged_order?: boolean | null;
  channel?: {
    name?: string | null;
    type_code?: string | null;
  } | null;
  store?: {
    name?: string | null;
  } | null;
  deliver_to?: {
    first_name?: string | null;
    last_name?: string | null;
    full_name?: string | null;
    address1?: string | null;
    address_line_1?: string | null;
    address2?: string | null;
    address_line_2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    postcode?: string | null;
    country?: string | null;
  } | null;
  customer?: {
    full_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null;
  status?: string;
}

export interface MergeableGroup {
  signature: string;
  channelKind: string; // "Amazon" | "Walmart" | ...
  storeName: string | null;
  recipient: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  orders: Array<{
    id: string;
    orderNumber: string;
    storeName: string | null;
  }>;
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

// Collapse internal whitespace, strip punctuation that varies between
// reps of the same address ("Apt #2" vs "Apt 2"). We don't try to
// normalise abbreviations like "St" vs "Street" yet — Vladimir asked
// us to match what Veeqo flags first; we tighten if we miss anything.
function normaliseLine(s: string | null | undefined): string {
  return lower(s)
    .replace(/[#.,]/g, " ") // strip the characters that drift between renderings
    .replace(/\s+/g, " ")
    .trim();
}

function fullName(o: VeeqoOrderForMerge): string {
  const d = o.deliver_to;
  const explicit = d?.full_name;
  if (explicit) return lower(explicit);
  const first = lower(d?.first_name) || lower(o.customer?.first_name);
  const last = lower(d?.last_name) || lower(o.customer?.last_name);
  const joined = `${first} ${last}`.trim();
  if (joined) return joined;
  return lower(o.customer?.full_name);
}

function normaliseChannelKind(typeCode: string | null | undefined): string {
  if (!typeCode) return "Other";
  const lower = typeCode.toLowerCase();
  if (lower === "amazon") return "Amazon";
  if (lower === "walmart") return "Walmart";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Address signature for grouping.
//
// PREFERRED: Veeqo's own `mergable_checksum`. It is the exact key their
// Mergeable view groups on, so using it makes our list agree with theirs by
// construction instead of by imitation — the whole reason the hand-rolled
// normalisation below carried a "tighten this if Veeqo flags pairs we miss"
// caveat. Verified 2026-07-31 against a real merge (see
// docs/wiki/merge-orders-veeqo-mechanics.md).
//
// FALLBACK: the normalised address below, for any order where Veeqo didn't
// supply a checksum.
//
// Either way the channel and store are prefixed, because a merge must stay
// inside one channel and one store (owner's 2026-05-17 decision, and every one
// of the 16 merges this account has actually performed obeyed it).
export function deliverySignature(order: VeeqoOrderForMerge): string | null {
  // An order already merged into a combined order is done — it must never be
  // offered as a candidate again, or the operator would be invited to merge a
  // shipment that has already shipped.
  if (order.merged_to_id != null) return null;
  // The combined order itself isn't a merge candidate either.
  if (order.merged_order === true) return null;

  const checksum = (order.mergable_checksum ?? "").trim();
  if (checksum) {
    const channelKind = normaliseChannelKind(order.channel?.type_code);
    const storeName = lower(order.store?.name ?? order.channel?.name ?? "");
    return [channelKind, storeName, "sum", checksum].join("|");
  }

  const d = order.deliver_to;
  if (!d) return null;
  const name = fullName(order);
  const addr1 = normaliseLine(d.address1 ?? d.address_line_1);
  const city = normaliseLine(d.city);
  const state = lower(d.state);
  const zip = lower(d.zip ?? d.postcode).split("-")[0];
  if (!name || !addr1 || !zip) return null; // not enough to group on
  const channelKind = normaliseChannelKind(order.channel?.type_code);
  const storeName = lower(order.store?.name ?? order.channel?.name ?? "");
  const addr2 = normaliseLine(d.address2 ?? d.address_line_2);
  return [channelKind, storeName, name, addr1, addr2, city, state, zip].join("|");
}

export function findMergeableGroups(
  orders: VeeqoOrderForMerge[],
): MergeableGroup[] {
  const buckets = new Map<string, VeeqoOrderForMerge[]>();
  for (const order of orders) {
    const sig = deliverySignature(order);
    if (!sig) continue;
    const list = buckets.get(sig);
    if (list) list.push(order);
    else buckets.set(sig, [order]);
  }

  const groups: MergeableGroup[] = [];
  for (const [signature, list] of buckets.entries()) {
    if (list.length < 2) continue;
    const first = list[0];
    const d = first.deliver_to ?? {};
    groups.push({
      signature,
      channelKind: normaliseChannelKind(first.channel?.type_code),
      storeName: first.store?.name ?? first.channel?.name ?? null,
      recipient: fullName(first),
      address: [d.address1 ?? d.address_line_1, d.address2 ?? d.address_line_2]
        .filter(Boolean)
        .join(", "),
      city: d.city ?? "",
      state: d.state ?? "",
      zip: d.zip ?? d.postcode ?? "",
      orders: list.map((o) => ({
        id: String(o.id ?? ""),
        orderNumber: o.number ?? String(o.id ?? ""),
        storeName: o.store?.name ?? o.channel?.name ?? null,
      })),
    });
  }
  // Largest groups first, then by recipient name for stable display.
  groups.sort((a, b) => {
    if (b.orders.length !== a.orders.length)
      return b.orders.length - a.orders.length;
    return a.recipient.localeCompare(b.recipient);
  });
  return groups;
}

// Deep-link to Veeqo's Mergeable view. Veeqo doesn't expose a way to
// pre-select specific order IDs, so we just open their full Mergeable
// list — the operator finds the pair by recipient/address (which we
// also show in our UI for cross-reference).
export function veeqoMergeableUrl(): string {
  return "https://app.veeqo.com/orders?status=awaiting_fulfillment&mergeable=true&pick_status=unpicked";
}
