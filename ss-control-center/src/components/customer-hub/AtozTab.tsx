"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const statusColors: Record<string, string> = {
  NEW: "bg-red-100 text-red-700",
  SUBMITTED: "bg-blue-100 text-blue-700",
  WON: "bg-green-100 text-green-700",
  LOST: "bg-red-600 text-white",
};

const strategyColors: Record<string, string> = {
  BUY_SHIPPING_PROTECTION: "bg-green-100 text-green-700",
  PROOF_OF_DELIVERY: "bg-blue-100 text-blue-700",
  MANUAL_REVIEW: "bg-slate-100 text-slate-600",
};

const mockClaims = [
  {
    id: "1",
    status: "NEW",
    store: "Salutem Solutions",
    orderId: "113-4567890-1234567",
    reason: "INR",
    amount: 41.24,
    deadline: "Apr 11",
    daysLeft: 2,
    strategy: "BUY_SHIPPING_PROTECTION",
  },
  {
    id: "2",
    status: "SUBMITTED",
    store: "Vladimir Personal",
    orderId: "114-7891234-5678901",
    reason: "SNAD",
    amount: 67.8,
    deadline: "Apr 14",
    daysLeft: 5,
    strategy: "PROOF_OF_DELIVERY",
  },
];

export default function AtozTab() {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Order ID</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Deadline</TableHead>
              <TableHead>Strategy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mockClaims.map((c) => (
              <TableRow key={c.id} className="cursor-pointer hover:bg-slate-50">
                <TableCell>
                  <Badge className={statusColors[c.status] || ""}>
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{c.store}</TableCell>
                <TableCell className="font-mono text-xs">{c.orderId}</TableCell>
                <TableCell className="text-xs">{c.reason}</TableCell>
                <TableCell className="text-right text-xs font-medium">
                  ${c.amount.toFixed(2)}
                </TableCell>
                <TableCell className="text-xs">
                  {c.deadline}
                  {c.daysLeft <= 3 && (
                    <Badge className="ml-1 bg-red-100 text-red-700 text-[9px]">
                      {c.daysLeft}d left
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge className={strategyColors[c.strategy] || "bg-slate-100 text-slate-600"}>
                    {c.strategy.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
