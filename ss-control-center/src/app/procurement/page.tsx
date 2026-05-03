"use client";

import { useEffect, useState } from "react";

interface Card {
  lineItemId: string;
  orderId: string;
  orderNumber: string;
  channel: string;
  storeName: string;
  productTitle: string;
  productImageUrl: string | null;
  sku: string;
  quantityOrdered: number;
  remaining: number;
  status: { kind: string; remaining?: number } | null;
  shipBy: string | null;
  isPremium: boolean;
  shippingMethod: string | null;
}

export default function ProcurementPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/procurement/items");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCards(data.cards ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  // Group line items by order so multi-item orders render as a single block
  // with a shared header.
  const grouped = cards.reduce<Record<string, Card[]>>((acc, c) => {
    (acc[c.orderId] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div style={{ padding: 16, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>
        Procurement (Phase 1 — bare bones)
      </h1>
      <button
        onClick={load}
        disabled={loading}
        style={{ margin: "12px 0" }}
      >
        {loading ? "Loading..." : "Refresh"}
      </button>
      {error && <div style={{ color: "red" }}>Error: {error}</div>}
      <div style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
        Total cards: {cards.length}
      </div>

      {Object.entries(grouped).map(([orderId, items]) => {
        const head = items[0];
        if (!head) return null;
        return (
          <div
            key={orderId}
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
              Order {head.orderNumber} · {head.channel}
              {head.isPremium && " · Premium"}
              {head.shipBy && ` · Ship by ${head.shipBy.slice(0, 10)}`}
            </div>
            {items.map((c) => (
              <div
                key={c.lineItemId}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "8px 0",
                  borderTop: "1px dashed #eee",
                }}
              >
                {c.productImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.productImageUrl}
                    alt=""
                    style={{
                      width: 60,
                      height: 60,
                      objectFit: "cover",
                      borderRadius: 4,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 60,
                      height: 60,
                      background: "#f0f0f0",
                      borderRadius: 4,
                    }}
                  />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{c.productTitle}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    SKU: {c.sku}
                  </div>
                  <div
                    style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}
                  >
                    {c.status?.kind === "remain"
                      ? `Осталось купить: ${c.remaining} из ${c.quantityOrdered}`
                      : `Купить: ${c.quantityOrdered} шт`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {!loading && cards.length === 0 && !error && (
        <div style={{ color: "#888" }}>Список пуст — всё закуплено</div>
      )}
    </div>
  );
}
