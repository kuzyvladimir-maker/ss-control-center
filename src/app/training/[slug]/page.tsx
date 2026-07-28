"use client";

/**
 * Training — single course detail.
 *
 * Client component reading the slug via useParams() (this repo's Next.js
 * conventions). Completion is persisted per-browser in localStorage under
 * `training-done:<slug>`.
 *
 * Persistence pattern (satisfies react-hooks/set-state-in-effect — we never
 * call setState inside useEffect):
 *   - `useMounted()` gates the completion control so SSR/first paint is
 *     deterministic (no hydration mismatch).
 *   - localStorage is read DURING RENDER, only when `mounted` is true.
 *   - clicking writes localStorage and bumps a tiny counter (`tick`) to force
 *     a re-render so the new state shows.
 */

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";
import { PageHead } from "@/components/kit";
import { Btn, Panel } from "@/components/kit";
import { useMounted } from "@/lib/use-mounted";
import { getCourse } from "@/lib/training/data";

function doneKey(slug: string) {
  return `training-done:${slug}`;
}

function BackLink() {
  return (
    <Link
      href="/training"
      className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink-2"
    >
      <ArrowLeft size={14} /> All courses
    </Link>
  );
}

export default function CourseDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const mounted = useMounted();
  // Bumped on toggle to force a re-render after we write localStorage.
  const [, setTick] = useState(0);
  const course = slug ? getCourse(slug) : undefined;

  if (!course) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <BackLink />
        <p className="mt-6 text-[13px] text-ink-2">Course not found.</p>
      </div>
    );
  }

  // Read completion during render (client-only) so first paint matches SSR.
  const done =
    mounted &&
    typeof window !== "undefined" &&
    window.localStorage.getItem(doneKey(course.slug)) === "1";

  const toggleDone = () => {
    const key = doneKey(course.slug);
    if (window.localStorage.getItem(key) === "1") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, "1");
    }
    setTick((t) => t + 1);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <BackLink />
      <div className="mt-3">
        <PageHead
          title={course.title}
          actions={
            mounted ? (
              done ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-green-soft px-3 py-1.5 text-[12.5px] font-medium text-green-ink">
                  <Check size={14} /> Completed
                </span>
              ) : (
                <Btn variant="primary" size="md" onClick={toggleDone}>
                  Mark as completed
                </Btn>
              )
            ) : null
          }
        />
      </div>

      <p className="text-[13px] leading-relaxed text-ink-2">{course.intro}</p>

      {mounted && done && (
        <button
          type="button"
          onClick={toggleDone}
          className="mt-2 text-[11.5px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          Mark as not completed
        </button>
      )}

      <div className="mt-6 space-y-5">
        {course.modules.map((mod, i) => (
          <section key={i}>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="grid h-5 min-w-5 place-items-center rounded bg-bg-elev px-1 font-mono text-[11px] font-semibold text-ink-2">
                {i + 1}
              </span>
              <h2 className="text-[13.5px] font-semibold text-ink">
                {mod.title}
              </h2>
            </div>
            <ul className="space-y-1.5 pl-7">
              {mod.items.map((item, j) => (
                <li
                  key={j}
                  className="flex gap-2 text-[13px] leading-relaxed text-ink-2"
                >
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {course.finalTest && (
        <section className="mt-6">
          <h2 className="mb-2 text-[13px] font-semibold text-ink">
            Финальный тест
          </h2>
          <Panel className="bg-surface-tint p-3">
            <p className="text-[13px] leading-relaxed text-ink-2">
              {course.finalTest}
            </p>
          </Panel>
        </section>
      )}

      {course.completionNote && (
        <section className="mt-6">
          <h2 className="mb-2 text-[13px] font-semibold text-ink">
            Зачёт / отметка о прохождении
          </h2>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {course.completionNote}
          </p>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-[13px] font-semibold text-ink">Источник</h2>
        <Panel className="bg-surface-tint p-3">
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            {course.source.name}
          </p>
          <p className="mt-1 font-mono text-[11px] text-ink-3">
            Google Drive fileId: {course.source.fileId}
          </p>
        </Panel>
      </section>
    </div>
  );
}
