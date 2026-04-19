/**
 * Branded placeholder for modules that haven't shipped yet.
 * Replaces the generic "Module in development" text on stub pages with
 * something that fits the Salutem design system.
 */

import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { Btn } from "./Btn";
import { PageHead } from "./PageHead";
import { Panel, PanelBody } from "./Card";

interface ComingSoonProps {
  title: string;
  tagline: string;
  bullets?: string[];
  /** Optional CTA — e.g. link to a related working module. */
  cta?: { label: string; href: string };
  eta?: string;
  icon?: React.ReactNode;
}

export function ComingSoon({
  title,
  tagline,
  bullets,
  cta,
  eta,
  icon,
}: ComingSoonProps) {
  return (
    <div className="space-y-5">
      <PageHead
        title={title}
        subtitle={
          <>
            <span className="rounded bg-bg-elev px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ink-2">
              Phase 2
            </span>
            <span className="text-ink-3">{tagline}</span>
          </>
        }
      />

      <Panel className="overflow-hidden">
        <div
          className="absolute inset-0 -z-10 opacity-30"
          aria-hidden
          style={{
            background:
              "radial-gradient(800px 200px at 80% 0%, var(--green-soft), transparent)",
          }}
        />
        <PanelBody className="relative px-8 py-12">
          <div className="mx-auto max-w-xl text-center">
            <div
              className="mx-auto grid h-12 w-12 place-items-center rounded-xl"
              style={{
                background: "var(--green-soft)",
                color: "var(--green-ink)",
              }}
            >
              {icon ?? <Sparkles size={20} />}
            </div>

            <h2
              className="mt-4 font-semibold text-ink"
              style={{ fontSize: 22, letterSpacing: "-0.02em" }}
            >
              {title} is coming next
            </h2>
            <p className="mt-1.5 text-[13.5px] text-ink-2">{tagline}</p>

            {bullets && bullets.length > 0 && (
              <ul className="mx-auto mt-5 max-w-md space-y-1.5 text-left">
                {bullets.map((b, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[12.5px] text-ink-2"
                  >
                    <span
                      className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full"
                      style={{ background: "var(--green)" }}
                    />
                    {b}
                  </li>
                ))}
              </ul>
            )}

            {eta && (
              <div className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-bg-elev px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-ink-2">
                <span className="live-dot" /> {eta}
              </div>
            )}

            {cta && (
              <div className="mt-6">
                <Link href={cta.href}>
                  <Btn variant="primary" icon={<ArrowRight size={13} />}>
                    {cta.label}
                  </Btn>
                </Link>
              </div>
            )}
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
