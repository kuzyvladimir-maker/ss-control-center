"use client";

import { useState } from "react";
import { Plus, Upload, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export default function WalmartCaseModal() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors">
        <Plus size={14} />
        Walmart Case
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart size={18} className="text-blue-600" />
            New Walmart Case
          </DialogTitle>
          <DialogDescription>
            Upload screenshots from Walmart Seller Center for AI analysis.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Drop zone */}
          <div className="flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-4 hover:border-blue-400 hover:bg-blue-50 transition-colors">
            <Upload className="mb-2 text-slate-400" size={28} />
            <p className="text-xs text-slate-600">
              Drag & drop screenshots, or click to browse
            </p>
            <p className="text-[10px] text-slate-400 mt-1">
              Order details, customer message, tracking page
            </p>
          </div>

          <Button disabled className="w-full">
            Analyze Screenshots
          </Button>

          <p className="text-[10px] text-slate-400 text-center">
            Walmart CS analysis via screenshots — full functionality coming soon
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
