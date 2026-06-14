# Procurement title source — prefer order-line over Veeqo catalog master

**Date:** 2026-06-13 · **Scope:** `src/lib/veeqo/orders-procurement.ts`, `ProcurementCard`.

## Bug

For Amazon order 112-2567667-5029814 (SKU `GQ-HHYX-3R29`), the Tyson wings listing
reads **"3 Pack"** on Amazon AND in Veeqo's order list, but our Procurement page
showed **"2 Pack"** and told the operator to buy **2 units** instead of 3.

The buy quantity is derived from the title: `parsePackSize(title)` → `totalPhysical =
quantityOrdered × packSize` ([ProcurementCard.tsx](../../ss-control-center/src/app/procurement/components/ProcurementCard.tsx)).
A wrong title → wrong buy quantity → **under-sourcing the multipack** (we buy-to-order,
so an order needing 3 physical units would ship short by 1).

## Root cause

`fetchProcurementCards` picked the title in this order:

```
product.title ?? product.name ?? sellable.title ?? sellable.product_title
```

`product.*` is Veeqo's **shared product-master** record — it can drift stale (here it
said "2 Pack"). `sellable.product_title` is the **order-line** title — what the customer
actually bought, and what Veeqo's own order list + Amazon display ("3 Pack"). We were
preferring the stale master over the accurate order line.

## Fix

1. **Flip the preference** to trust the order line:
   ```
   sellable.product_title ?? sellable.title ?? product.title ?? product.name
   ```
   Now our title matches Veeqo + Amazon, and the pack parser reads the correct size →
   "Купить: 3 шт".

2. **Mismatch guard** — `packSizeWarning`: when the order-line title and the catalog
   master title parse to *different* pack sizes, the card shows an amber warning
   ("Veeqo каталог: N-pack, заказ: M-pack — берём заказ"). This catches the same class
   of Veeqo data drift going forward, even though we now use the correct title.

3. *(Optional, manual)* Correct the stale product-master title in Veeqo so every system
   agrees. The code fix is safe without it.

## Note
Could not validate live from a dev machine — Veeqo returns 401 locally (it appears to
allowlist Vercel egress IPs), so the diagnosis is from the code path, which leaves no
other source for the displayed title. Verify on prod after deploy.
