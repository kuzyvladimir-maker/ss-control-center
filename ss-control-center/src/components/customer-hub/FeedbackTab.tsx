"use client";

import { Star } from "lucide-react";
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
  NEW: "bg-slate-100 text-slate-600",
  REMOVAL_SUBMITTED: "bg-amber-100 text-amber-700",
  REMOVED: "bg-green-100 text-green-700",
  DENIED: "bg-red-100 text-red-700",
};

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={12}
          className={
            s <= rating
              ? "fill-amber-400 text-amber-400"
              : "text-slate-200"
          }
        />
      ))}
    </span>
  );
}

const mockFeedback = [
  {
    id: "1",
    rating: 1,
    store: "Salutem Solutions",
    date: "Apr 7",
    comment: "Product was warm when it arrived. Jimmy Dean sausages completely thawed.",
    removable: true,
    removableReason: "Product review in seller feedback",
    status: "NEW",
  },
  {
    id: "2",
    rating: 2,
    store: "Vladimir Personal",
    date: "Apr 5",
    comment: "Took forever to ship. Very slow seller.",
    removable: false,
    removableReason: null,
    status: "NEW",
  },
  {
    id: "3",
    rating: 5,
    store: "Salutem Solutions",
    date: "Apr 4",
    comment: "Great product, fast delivery! Will order again.",
    removable: false,
    removableReason: null,
    status: "NEW",
  },
];

export default function FeedbackTab() {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rating</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead>Removable?</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mockFeedback.map((fb) => (
              <TableRow
                key={fb.id}
                className={`cursor-pointer hover:bg-slate-50 ${fb.rating <= 2 ? "bg-red-50/30" : ""}`}
              >
                <TableCell>
                  <Stars rating={fb.rating} />
                </TableCell>
                <TableCell className="text-xs">{fb.store}</TableCell>
                <TableCell className="text-xs text-slate-500">
                  {fb.date}
                </TableCell>
                <TableCell className="text-xs max-w-[300px] truncate">
                  {fb.comment}
                </TableCell>
                <TableCell>
                  {fb.removable ? (
                    <Badge className="bg-green-100 text-green-700">Yes</Badge>
                  ) : (
                    <Badge className="bg-slate-100 text-slate-500">No</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge className={statusColors[fb.status] || ""}>
                    {fb.status}
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
