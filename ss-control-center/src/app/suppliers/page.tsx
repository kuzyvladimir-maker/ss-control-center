"use client";
import { ShoppingCart } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function SuppliersPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800">Supplier Management</h1>
        <Button size="sm" disabled>Add Supplier</Button>
      </div>
      <Card>
        <CardContent className="py-12 text-center">
          <ShoppingCart size={32} className="mx-auto text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-600">Manage suppliers and purchase orders</p>
          <p className="text-xs text-slate-400 mt-1">Track inventory sources and reorder schedules</p>
          <p className="text-xs text-slate-400 mt-3">Module in development</p>
        </CardContent>
      </Card>
    </div>
  );
}
