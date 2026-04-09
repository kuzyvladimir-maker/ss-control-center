"use client";
import { Megaphone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function PromotionsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800">Promotions</h1>
        <Button size="sm" disabled>Create Promotion</Button>
      </div>
      <Card>
        <CardContent className="py-12 text-center">
          <Megaphone size={32} className="mx-auto text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-600">Manage promotions and deals across marketplaces</p>
          <p className="text-xs text-slate-400 mt-1">Run campaigns on Amazon and Walmart</p>
          <p className="text-xs text-slate-400 mt-3">Module in development</p>
        </CardContent>
      </Card>
    </div>
  );
}
