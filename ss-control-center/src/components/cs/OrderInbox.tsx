"use client";

import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Order {
  orderId: string;
  buyerName: string;
  orderDate: string;
  orderStatus: string;
  orderTotal: string | null;
  itemCount: number;
}

const statusColors: Record<string, string> = {
  Shipped: "bg-green-100 text-green-700",
  Unshipped: "bg-amber-100 text-amber-700",
  Pending: "bg-yellow-100 text-yellow-700",
  Canceled: "bg-red-100 text-red-700",
  PartiallyShipped: "bg-blue-100 text-blue-700",
};

interface OrderInboxProps {
  orders: Order[];
  loading: boolean;
  selectedOrderId: string | null;
  onSelectOrder: (order: Order) => void;
}

export default function OrderInbox({
  orders,
  loading,
  selectedOrderId,
  onSelectOrder,
}: OrderInboxProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={18} className="animate-spin text-slate-400 mr-2" />
        <span className="text-xs text-slate-400">Loading orders...</span>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <p className="text-xs text-slate-400 text-center py-8">
        No recent orders
      </p>
    );
  }

  return (
    <div className="space-y-0.5 max-h-[600px] overflow-y-auto">
      <p className="text-[10px] text-slate-400 px-2 py-1">
        {orders.length} recent orders
      </p>
      {orders.map((order) => {
        const selected = order.orderId === selectedOrderId;
        const sc = statusColors[order.orderStatus] || "bg-slate-100 text-slate-500";
        return (
          <button
            key={order.orderId}
            onClick={() => onSelectOrder(order)}
            className={`w-full text-left px-3 py-2.5 rounded-md transition-colors ${
              selected
                ? "bg-blue-50 border border-blue-200"
                : "hover:bg-slate-50 border border-transparent"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700 truncate max-w-[140px]">
                {order.buyerName}
              </span>
              <Badge className={`text-[9px] px-1.5 py-0 ${sc}`}>
                {order.orderStatus}
              </Badge>
            </div>
            <p className="text-[10px] text-slate-400 mt-0.5 font-mono">
              {order.orderId}
            </p>
            <div className="flex items-center justify-between mt-0.5 text-[10px] text-slate-400">
              <span>
                {new Date(order.orderDate).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              {order.orderTotal && (
                <span className="font-medium text-slate-500">
                  {order.orderTotal}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
