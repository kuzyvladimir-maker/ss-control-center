"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  Upload,
  ShoppingCart,
  Loader2,
  X,
  Copy,
  Check,
  RefreshCw,
  Save,
  AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalmartAnalysis {
  orderId: string | null;
  customerName: string | null;
  product: string | null;
  customerMessage: string | null;
  problemType: string | null;
  problemTypeName: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  action: string | null;
  whoShouldPay: string | null;
  suggestedResponse: string | null;
  reasoning: string | null;
}

type ModalState = "upload" | "analyzing" | "result";

interface UploadedImage {
  id: string;
  // Raw base64 (no data URI prefix) for sending to the API
  base64: string;
  // Data URI for preview in <img>
  dataUri: string;
  name: string;
}

const riskColors: Record<string, string> = {
  LOW: "bg-green-soft2 text-green-ink",
  MEDIUM: "bg-warn-tint text-warn-strong",
  HIGH: "bg-danger-tint text-danger",
  CRITICAL: "bg-danger text-green-cream",
};

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function fileToImage(file: File): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read file as data URL"));
        return;
      }
      const base64 = result.replace(/^data:image\/\w+;base64,/, "");
      resolve({
        id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        base64,
        dataUri: result,
        name: file.name || "pasted-image.png",
      });
    };
    reader.onerror = () => reject(new Error("File read error"));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalmartCaseModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ModalState>("upload");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [analysis, setAnalysis] = useState<WalmartAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editingResponse, setEditingResponse] = useState(false);
  const [responseDraft, setResponseDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset everything when the dialog is closed
  useEffect(() => {
    if (!open) {
      // Delay reset so the fade-out animation doesn't show blank state
      const t = setTimeout(() => {
        setState("upload");
        setImages([]);
        setAnalysis(null);
        setError(null);
        setCopied(false);
        setSaving(false);
        setSaved(false);
        setEditingResponse(false);
        setResponseDraft("");
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setError(null);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    try {
      const next = await Promise.all(list.map(fileToImage));
      setImages((prev) => [...prev, ...next]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read images");
    }
  }, []);

  // Paste handler — only active while the modal is open
  useEffect(() => {
    if (!open) return;
    const handler = async (e: ClipboardEvent) => {
      if (state !== "upload") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        await addFiles(files);
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [open, state, addFiles]);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      await addFiles(e.dataTransfer.files);
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  const runAnalysis = async () => {
    if (images.length === 0) return;
    setState("analyzing");
    setError(null);
    try {
      const res = await fetch("/api/customer-hub/walmart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: images.map((i) => i.base64) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.analysis) {
        throw new Error("Empty analysis response");
      }
      setAnalysis(data.analysis as WalmartAnalysis);
      setResponseDraft(data.analysis.suggestedResponse || "");
      setState("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
      setState("upload");
    }
  };

  const handleCopyResponse = async () => {
    const text = editingResponse
      ? responseDraft
      : analysis?.suggestedResponse || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  const handleReanalyze = () => {
    setAnalysis(null);
    setError(null);
    setEditingResponse(false);
    setResponseDraft("");
    setSaved(false);
    runAnalysis();
  };

  const handleSave = async () => {
    if (!analysis) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/customer-hub/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_walmart",
          data: {
            ...analysis,
            suggestedResponse: editingResponse
              ? responseDraft
              : analysis.suggestedResponse,
            // Save the first image as thumbnail reference (images can be big,
            // one is enough for the history list)
            imageData: images[0]?.base64 || null,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-tint transition-colors">
        <Plus size={14} />
        Walmart Case
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart size={18} className="text-green" />
            Walmart Case Analysis
          </DialogTitle>
          <DialogDescription>
            Upload Walmart Seller Center screenshots — Claude will extract
            order details and draft a response.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-danger/20 bg-danger-tint p-3 text-xs text-danger flex items-start gap-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* -------------------- UPLOAD state -------------------- */}
        {state === "upload" && (
          <div className="space-y-4 pt-2">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors ${
                isDragging
                  ? "border-green bg-green-soft"
                  : "border-silver-line bg-surface-tint hover:border-green-mid hover:bg-green-soft"
              }`}
            >
              <Upload className="mb-2 text-ink-3" size={28} />
              <p className="text-xs text-ink-2">
                Drag &amp; drop screenshots, click to browse, or paste from
                clipboard (⌘V)
              </p>
              <p className="text-[10px] text-ink-3 mt-1">
                Order details, customer message, tracking page — PNG or JPG
              </p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={async (e) => {
                if (e.target.files) await addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {images.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="relative rounded border border-rule overflow-hidden bg-surface-tint aspect-video"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.dataUri}
                      alt={img.name}
                      className="w-full h-full object-cover"
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImage(img.id);
                      }}
                      className="absolute top-1 right-1 rounded-full bg-white/90 p-0.5 text-danger hover:bg-white shadow-sm"
                      aria-label="Remove image"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <Button
              onClick={runAnalysis}
              disabled={images.length === 0}
              className="w-full"
            >
              <Upload size={14} className="mr-1" />
              Analyze {images.length} screenshot{images.length !== 1 ? "s" : ""}
            </Button>
          </div>
        )}

        {/* -------------------- ANALYZING state -------------------- */}
        {state === "analyzing" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 size={32} className="animate-spin text-green" />
            <p className="text-sm text-ink-2">
              Analyzing {images.length} screenshot
              {images.length !== 1 ? "s" : ""}…
            </p>
            <p className="text-[10px] text-ink-3">
              Sending to Claude vision — this usually takes 5–15 seconds
            </p>
          </div>
        )}

        {/* -------------------- RESULT state -------------------- */}
        {state === "result" && analysis && (
          <div className="space-y-4 pt-2 text-xs">
            {/* Thumbnails */}
            {images.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="shrink-0 rounded border border-rule overflow-hidden bg-surface-tint w-24 h-16"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.dataUri}
                      alt={img.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Analysis verdict */}
            <div className="rounded border border-rule p-3 space-y-2">
              <p className="text-ink-3 font-medium">Analysis</p>
              <div className="flex flex-wrap items-center gap-2">
                {analysis.problemType && (
                  <Badge variant="outline">
                    {analysis.problemType}
                    {analysis.problemTypeName && ` — ${analysis.problemTypeName}`}
                  </Badge>
                )}
                {analysis.riskLevel && (
                  <Badge className={riskColors[analysis.riskLevel] || ""}>
                    {analysis.riskLevel}
                  </Badge>
                )}
                {analysis.action && (
                  <Badge className="bg-green-soft2 text-green-deep">
                    Action: {analysis.action.replace(/_/g, " ")}
                  </Badge>
                )}
                {analysis.whoShouldPay && (
                  <Badge className="bg-bg-elev text-ink-2">
                    Pays: {analysis.whoShouldPay}
                  </Badge>
                )}
              </div>
              {analysis.reasoning && (
                <p className="text-ink-2">{analysis.reasoning}</p>
              )}
            </div>

            {/* Extracted facts */}
            <div className="rounded border border-rule p-3 space-y-1">
              <p className="text-ink-3 font-medium mb-1">
                Extracted from screenshots
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div>
                  <span className="text-ink-3">Order ID:</span>{" "}
                  {analysis.orderId ? (
                    <code className="bg-surface-tint rounded px-1">
                      {analysis.orderId}
                    </code>
                  ) : (
                    "—"
                  )}
                </div>
                <div>
                  <span className="text-ink-3">Customer:</span>{" "}
                  {analysis.customerName || "—"}
                </div>
                <div className="col-span-2">
                  <span className="text-ink-3">Product:</span>{" "}
                  {analysis.product || "—"}
                </div>
              </div>
              {analysis.customerMessage && (
                <div className="mt-2">
                  <p className="text-ink-3 mb-1">Customer message:</p>
                  <div className="whitespace-pre-wrap rounded bg-surface-tint p-2 border border-rule">
                    {analysis.customerMessage}
                  </div>
                </div>
              )}
            </div>

            {/* Suggested response */}
            <div className="rounded border border-rule p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-ink-3 font-medium">Suggested response</p>
                {!editingResponse && (
                  <button
                    onClick={() => {
                      setEditingResponse(true);
                      setResponseDraft(analysis.suggestedResponse || "");
                    }}
                    className="text-[10px] text-green hover:underline"
                  >
                    Edit
                  </button>
                )}
              </div>
              {editingResponse ? (
                <textarea
                  value={responseDraft}
                  onChange={(e) => setResponseDraft(e.target.value)}
                  className="w-full min-h-[120px] rounded border border-rule p-2 text-xs focus:border-green-mid focus:outline-none"
                />
              ) : (
                <div className="whitespace-pre-wrap rounded bg-white border border-rule p-3">
                  {analysis.suggestedResponse || (
                    <span className="text-ink-3 italic">(no response)</span>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyResponse}
                disabled={!analysis.suggestedResponse && !responseDraft}
                className="text-xs"
              >
                {copied ? (
                  <Check size={12} className="mr-1 text-green" />
                ) : (
                  <Copy size={12} className="mr-1" />
                )}
                Copy Response
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleReanalyze}
                className="text-xs"
              >
                <RefreshCw size={12} className="mr-1" />
                Re-analyze
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || saved}
                className="text-xs bg-green hover:bg-green-deep"
              >
                {saving ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : saved ? (
                  <Check size={12} className="mr-1" />
                ) : (
                  <Save size={12} className="mr-1" />
                )}
                {saved ? "Saved" : "Save to History"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
