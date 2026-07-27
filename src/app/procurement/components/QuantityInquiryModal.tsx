"use client";

import { useMemo, useState } from "react";
import { X, AlertCircle, Check, Mail, Info } from "lucide-react";
import { Btn } from "@/components/kit";
import { buildInquiryEmail } from "@/lib/procurement/quantity-inquiry";

interface QuantityInquiryModalProps {
  /** Walmart customer order number (the 2000… number). */
  orderNumber: string;
  /** Optional fast-path PO (from the live cancellation sweep). */
  purchaseOrderId?: string | null;
  sku?: string;
  productTitle: string;
  /** Listing-level quantity the buyer selected. */
  orderedQty: number;
  packSize?: number | null;
  packLabel?: string | null;
  customerName?: string | null;
  onClose: () => void;
  /** Fired after a successful send so the page can flip the card chip. */
  onSent: (orderNumber: string) => void;
}

/**
 * Compose-and-send modal for the "did you mean this quantity?" buyer email.
 *
 * Opens from the procurement card (anomaly badge or ⋮ menu). The subject +
 * body are prefilled from buildInquiryEmail and Vladimir can edit before
 * sending. The actual buyer address is never shown or entered here — the
 * server resolves Walmart's per-order relay address itself and sends from the
 * registered Sirius CS mailbox. Strictly an order-clarification message:
 * Walmart's Customer Care Policy forbids marketing / feedback requests.
 */
export function QuantityInquiryModal({
  orderNumber,
  purchaseOrderId,
  sku,
  productTitle,
  orderedQty,
  packSize,
  packLabel,
  customerName,
  onClose,
  onSent,
}: QuantityInquiryModalProps) {
  const totalUnits = orderedQty * (packSize && packSize > 0 ? packSize : 1);

  const prefilled = useMemo(
    () =>
      buildInquiryEmail({
        orderNumber,
        customerName,
        productTitle,
        orderedQty,
        packLabel,
        totalUnits,
      }),
    [orderNumber, customerName, productTitle, orderedQty, packLabel, totalUnits],
  );

  const [subject, setSubject] = useState(prefilled.subject);
  const [body, setBody] = useState(prefilled.body);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSend() {
    if (!subject.trim() || !body.trim()) {
      setError("Тема и текст письма не могут быть пустыми");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/procurement/inquire-quantity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderNumber,
          purchaseOrderId: purchaseOrderId ?? undefined,
          sku,
          productTitle,
          orderedQty,
          packSize: packSize ?? undefined,
          packLabel: packLabel ?? undefined,
          customerName: customerName ?? undefined,
          subject: subject.trim(),
          body,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSent(true);
      onSent(orderNumber);
      // Hold the success state briefly so Vladimir sees the confirmation.
      setTimeout(onClose, 1100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[600px] flex-col overflow-hidden rounded-xl bg-surface ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Mail size={14} className="text-info" />
              Уточнить количество у клиента
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
              #{orderNumber} · {customerName || "клиент"} ·{" "}
              {orderedQty} × {packLabel || "ед."} = {totalUnits} шт
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink"
            aria-label="Закрыть"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3 inline-flex items-start gap-1.5 rounded-md bg-info-tint/60 px-2.5 py-1.5 text-[11.5px] text-info">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>
              Письмо уйдёт через Walmart-relay с ящика info.siriustrading@gmail.com.
              Только вопрос по заказу — без маркетинга и просьб об отзыве (это
              требование политики Walmart).
            </span>
          </div>

          <label
            htmlFor="inq-subject"
            className="text-[11px] font-medium text-ink-3"
          >
            Тема
          </label>
          <input
            id="inq-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sending || sent}
            className="mt-1 h-9 w-full rounded-md border border-rule bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-silver-line disabled:opacity-60"
          />

          <label
            htmlFor="inq-body"
            className="mt-3 block text-[11px] font-medium text-ink-3"
          >
            Текст письма (английский — клиент англоязычный)
          </label>
          <textarea
            id="inq-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sending || sent}
            rows={11}
            className="mt-1 w-full resize-y rounded-md border border-rule bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-silver-line disabled:opacity-60"
          />

          {error && (
            <div className="mt-3 inline-flex items-start gap-1.5 rounded-md bg-danger-tint px-2 py-1.5 text-[12px] text-danger">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-rule px-4 py-3">
          <Btn variant="ghost" size="sm" onClick={onClose} disabled={sending}>
            Отмена
          </Btn>
          <Btn
            variant="primary"
            size="sm"
            loading={sending}
            disabled={sent}
            icon={sent ? <Check size={13} /> : <Mail size={13} />}
            onClick={handleSend}
          >
            {sent ? "Отправлено" : "Отправить клиенту"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
