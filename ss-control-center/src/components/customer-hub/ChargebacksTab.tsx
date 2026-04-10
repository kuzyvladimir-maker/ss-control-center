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

const mockChargebacks = [
  {
    id: "1",
    status: "PENDING",
    store: "Salutem Solutions",
    orderId: "113-0196033-6384224",
    amount: 108.84,
    reason: "Fraudulent transaction",
    replyBy: "Apr 10",
    daysLeft: 1,
    carrier: "UPS Ground",
  },
];

export default function ChargebacksTab() {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Order ID</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Reply-By</TableHead>
              <TableHead>Carrier</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mockChargebacks.map((cb) => (
              <TableRow
                key={cb.id}
                className="cursor-pointer hover:bg-slate-50 bg-red-50/30"
              >
                <TableCell>
                  <Badge className="bg-red-100 text-red-700">
                    {cb.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{cb.store}</TableCell>
                <TableCell className="font-mono text-xs">
                  {cb.orderId}
                </TableCell>
                <TableCell className="text-right text-xs font-medium text-red-600">
                  ${cb.amount.toFixed(2)}
                </TableCell>
                <TableCell className="text-xs">{cb.reason}</TableCell>
                <TableCell className="text-xs">
                  {cb.replyBy}
                  <Badge className="ml-1 bg-red-600 text-white text-[9px]">
                    {cb.daysLeft}d left!
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{cb.carrier}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
