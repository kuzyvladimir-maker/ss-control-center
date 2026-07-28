"use client";

/**
 * Training — list of staff courses.
 *
 * Each course card drills into `/training/<slug>`. Completion is tracked
 * per-browser in localStorage (v1) on the detail page.
 */

import Link from "next/link";
import { PageHead } from "@/components/kit";
import { Panel } from "@/components/kit";
import { COURSES } from "@/lib/training/data";

export default function TrainingPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
      <PageHead title="Training" subtitle="Staff courses & completion" />

      <div className="grid gap-3 sm:grid-cols-2">
        {COURSES.map((course) => (
          <Link
            key={course.slug}
            href={`/training/${course.slug}`}
            className="block"
          >
            <Panel className="h-full p-4 transition-colors hover:bg-surface-tint">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-[14px] font-semibold leading-snug text-ink">
                  {course.title}
                </h3>
                <span className="shrink-0 rounded bg-bg-elev px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  {course.modules.length} modules
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-ink-2">
                {course.intro}
              </p>
            </Panel>
          </Link>
        ))}
      </div>
    </div>
  );
}
