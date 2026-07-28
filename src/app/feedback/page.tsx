"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Star, MessageSquareText, ShoppingBag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import FeedbackTable from "@/components/feedback/FeedbackTable";

export default function FeedbackPage() {
  const [mounted, setMounted] = useState(false);

  // Seller feedback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [feedbackItems, setFeedbackItems] = useState<any[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [fbLoading, setFbLoading] = useState(false);
  const [fbFilters, setFbFilters] = useState({
    rating: "",
    store: "",
    status: "",
  });

  // Product reviews
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [reviews, setReviews] = useState<any[]>([]);
  const [reviewsTotal, setReviewsTotal] = useState(0);
  const [revLoading, setRevLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchFeedback = useCallback(async () => {
    setFbLoading(true);
    try {
      const params = new URLSearchParams({ type: "seller" });
      if (fbFilters.rating) params.set("rating", fbFilters.rating);
      if (fbFilters.store) params.set("store", fbFilters.store);
      if (fbFilters.status) params.set("status", fbFilters.status);
      const res = await fetch(`/api/feedback?${params.toString()}`);
      const data = await res.json();
      setFeedbackItems(data.items || []);
      setFeedbackTotal(data.total || 0);
    } catch {
      console.error("Failed to fetch feedback");
    } finally {
      setFbLoading(false);
    }
  }, [fbFilters]);

  const fetchReviews = useCallback(async () => {
    setRevLoading(true);
    try {
      const res = await fetch("/api/feedback?type=reviews&limit=50");
      const data = await res.json();
      setReviews(data.items || []);
      setReviewsTotal(data.total || 0);
    } catch {
      console.error("Failed to fetch reviews");
    } finally {
      setRevLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mounted) {
      fetchFeedback();
      fetchReviews();
    }
  }, [mounted, fetchFeedback, fetchReviews]);

  if (!mounted) return null;

  // Stats from current data
  const negative = feedbackItems.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f: any) => f.rating <= 2
  ).length;
  const removable = feedbackItems.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f: any) => f.removable === true
  ).length;
  const removed = feedbackItems.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f: any) => f.removalDecision === "REMOVED"
  ).length;
  const submitted = feedbackItems.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f: any) => f.status === "REMOVAL_SUBMITTED" || f.removalDecision
  ).length;
  const successRate = submitted > 0 ? Math.round((removed / submitted) * 100) : 0;
  const allRatings = feedbackItems
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((f: any) => f.rating)
    .filter(Boolean);
  const avgRating =
    allRatings.length > 0
      ? (allRatings.reduce((a: number, b: number) => a + b, 0) / allRatings.length).toFixed(1)
      : "—";

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-ink-3">Negative (1-2)</p>
            <p className="text-2xl font-bold text-danger">{negative}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-ink-3">Removable Found</p>
            <p className="text-2xl font-bold text-green">{removable}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-ink-3">Removal Success</p>
            <p className="text-2xl font-bold text-green">{successRate}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-ink-3">Avg Rating</p>
            <p className="text-2xl font-bold text-warn flex items-center gap-1">
              {avgRating} <Star size={16} className="fill-warn text-warn" />
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="seller">
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="seller" className="gap-1.5 px-4">
            <MessageSquareText size={15} />
            Seller Feedback
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-1.5 px-4">
            <ShoppingBag size={15} />
            Product Reviews ({reviewsTotal})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="seller">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                Seller Feedback
                {fbLoading && <Loader2 size={16} className="animate-spin text-ink-3" />}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FeedbackTable
                items={feedbackItems}
                total={feedbackTotal}
                filters={fbFilters}
                onFiltersChange={setFbFilters}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reviews">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                Product Reviews
                {revLoading && <Loader2 size={16} className="animate-spin text-ink-3" />}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {reviews.length === 0 ? (
                <p className="text-sm text-ink-3 py-4 text-center">
                  No product reviews yet
                </p>
              ) : (
                <div className="space-y-3">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {reviews.map((r: any) => (
                    <div
                      key={r.id}
                      className={`rounded-lg border p-3 ${r.rating <= 2 ? "border-danger/20 bg-danger-tint/30" : "border-rule"}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {[1, 2, 3, 4, 5].map((s) => (
                            <Star
                              key={s}
                              size={12}
                              className={
                                s <= r.rating
                                  ? "fill-warn text-warn"
                                  : "text-ink-4"
                              }
                            />
                          ))}
                          {r.title && (
                            <span className="text-xs font-medium ml-1">
                              {r.title}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-ink-3">
                          {r.reviewDate}
                        </span>
                      </div>
                      {r.body && (
                        <p className="text-xs text-ink-2 mt-1">{r.body}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
