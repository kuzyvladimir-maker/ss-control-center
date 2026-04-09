"use client";
import { Tags } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function ListingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-800">Product Listings</h1>
      <Card>
        <CardContent className="py-12 text-center">
          <Tags size={32} className="mx-auto text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-600">Manage product listings across all stores</p>
          <p className="text-xs text-slate-400 mt-1">Powered by Sellbrite API</p>
          <p className="text-xs text-green-600 mt-3">API credentials: Configured</p>
          <p className="text-xs text-slate-400">Integration in development</p>
        </CardContent>
      </Card>
    </div>
  );
}
