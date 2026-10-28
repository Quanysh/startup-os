"use client";

import {
  BanknoteIcon,
  BriefcaseBusinessIcon,
  CalendarClockIcon,
  CpuIcon,
  ExternalLinkIcon,
  MergeIcon,
  NewspaperIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  UserRoundCogIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  isArtifactUrl,
  newestSignals,
  type DealIntel,
  type IntelFit,
  type SignalKind,
} from "@convex/lib/dealIntel";
import { Panel } from "@/components/panel";
import { KindTag } from "@/components/ui/status-chip";
import { SIGNAL_KIND_LABELS, initialsOf, signalDateLabel } from "@/lib/pipeline/intel-view";
import { BILLING_LABELS } from "@/lib/pipeline/table-view";
import { cn } from "@/lib/utils";

// The pieces of a US deal's page that show its sales intelligence. Every
// text here came from research or a person: it is rendered as text, never as
// markup, and the only link is a source's claude.ai artifact (checked again
// here before an href is made of it).

/** A section of the page with its heading. */
export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <Panel aria-labelledby={id} className={className}>
      <h2 id={id} className="mb-3 text-sm font-medium text-ink">
        {title}
      </h2>
      {children}
    </Panel>
  );
}

/**
 * Research's fit score: the figure, a bar for the eye, and its reasons on
 * hover, on focus and on a press (for a phone).
 */
export function FitMeter({ fit }: { fit: IntelFit }) {
  const [open, setOpen] = useState(false);
  const reasonsId = useId();
  const hasReasons = fit.reasons.length > 0;
  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        aria-label={`Fit ${fit.score} of 100`}
        aria-describedby={hasReasons ? reasonsId : undefined}
        aria-expanded={hasReasons ? open : undefined}
        onClick={() => setOpen((was) => !was)}
        className="inline-flex items-center gap-2.5 rounded-full bg-surface py-1.5 pr-3.5 pl-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="text-xs text-ink-2">Fit</span>
        <span aria-hidden className="h-2 w-20 overflow-hidden rounded-full bg-panel sm:w-28">
          <span className="block h-full rounded-full bg-brand" style={{ width: `${fit.score}%` }} />
        </span>
        <span className="text-base leading-none font-semibold text-ink">{fit.score}</span>
        <span className="text-xs text-ink-2">of 100</span>
      </button>
      {hasReasons && (
        <div
          id={reasonsId}
          role="tooltip"
          className={cn(
            // Under the meter's left edge on a phone (where it starts the line), its right on a wider screen.
            "absolute top-full left-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-inner bg-panel p-3 text-left shadow-soft sm:right-0 sm:left-auto",
            open ? "block" : "hidden group-focus-within:block group-hover:block",
          )}
        >
          <p className="text-xs font-medium text-ink">Why this fit</p>
          <ul className="mt-1.5 space-y-1 text-xs text-ink-2">
            {fit.reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-3" />
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const SIGNAL_ICONS: Record<SignalKind, LucideIcon> = {
  hiring: BriefcaseBusinessIcon,
  funding: BanknoteIcon,
  acquisition: MergeIcon,
  technology: CpuIcon,
  leadership: UserRoundCogIcon,
  growth: TrendingUpIcon,
  news: NewspaperIcon,
  meeting: CalendarClockIcon,
};

/** What research saw happen, newest first: a line of time with each kind's mark. */
export function SignalsTimeline({ signals }: { signals: DealIntel["signals"] }) {
  return (
    <ol className="ml-3.5 space-y-5 border-l border-line pl-6">
      {newestSignals(signals, signals.length).map((signal, index) => {
        const Icon = SIGNAL_ICONS[signal.kind];
        const date = signalDateLabel(signal.date);
        return (
          <li key={`${signal.date ?? ""}-${index}`} className="relative">
            <span
              aria-hidden
              className="absolute top-0 -left-[2.4rem] grid size-7 place-items-center rounded-full bg-surface text-ink-2 ring-4 ring-panel"
            >
              <Icon className="size-3.5" />
            </span>
            <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
              {date === null ? (
                <span className="text-ink-2">Undated</span>
              ) : (
                <time dateTime={signal.date} className="font-medium text-ink">
                  {date}
                </time>
              )}
              <span className="text-ink-2">{SIGNAL_KIND_LABELS[signal.kind]}</span>
            </p>
            <p className="mt-0.5 text-sm text-ink">{signal.text}</p>
            <p className="mt-0.5 text-xs text-ink-2">{`Source: ${signal.source}`}</p>
          </li>
        );
      })}
    </ol>
  );
}

/** Who is there, by name and role. */
export function PeopleList({ people }: { people: DealIntel["people"] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {people.map((person, index) => (
        <li key={`${person.name}-${index}`} className="flex gap-3 rounded-inner bg-surface p-3">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-full bg-panel text-xs font-semibold text-ink-2"
          >
            {initialsOf(person.name)}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{person.name}</p>
            <p className="text-xs text-ink-2">{person.role}</p>
            {person.note && <p className="mt-1 text-xs text-ink-2">{person.note}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const tags = (items: readonly string[]) => (
  <span className="flex flex-wrap gap-1">
    {items.map((item) => (
      <span key={item} className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-2">
        {item}
      </span>
    ))}
  </span>
);

/** The practice's systems and how it bills, as research found them; what is unknown is left out. */
export function TechAndBilling({ intel }: { intel: DealIntel }) {
  const rows: [string, ReactNode][] = [];
  if (intel.ehr) rows.push(["EHR", intel.ehr]);
  if (intel.pm) rows.push(["Practice management", intel.pm]);
  if (intel.billingModel) rows.push(["Billing", BILLING_LABELS[intel.billingModel]]);
  if (intel.rcmVendor) rows.push(["RCM vendor", intel.rcmVendor]);
  if (intel.specialties.length > 0) rows.push(["Specialties", tags(intel.specialties)]);
  if (intel.ancillaries.length > 0) rows.push(["Ancillaries", tags(intel.ancillaries)]);
  if (intel.workersComp) rows.push(["Workers' comp", intel.workersComp]);
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-ink-2">{term}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Whether there is anything for `TechAndBilling` to show. */
export const hasTechAndBilling = (intel: DealIntel) =>
  Boolean(intel.ehr || intel.pm || intel.billingModel || intel.rcmVendor || intel.workersComp) ||
  intel.specialties.length > 0 ||
  intel.ancillaries.length > 0;

/** Who else is in the deal, each with what research said of them. */
export function CompetitorList({ competitors }: { competitors: DealIntel["competitors"] }) {
  return (
    <ul className="space-y-2.5">
      {competitors.map((competitor, index) => (
        <li key={`${competitor.name}-${index}`} className="space-y-1">
          <KindTag tone="plum">{competitor.name}</KindTag>
          {competitor.note && <p className="text-sm text-ink-2">{competitor.note}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Pain points, talking points and risks: short lists, each under its own heading. */
export function PointLists({ intel }: { intel: DealIntel }) {
  const lists: [string, readonly string[], boolean][] = [
    ["Pain points", intel.painPoints, false],
    ["Talking points", intel.talkingPoints, false],
    ["Risks", intel.risks, true],
  ];
  return (
    <div className="space-y-4">
      {lists
        .filter(([, items]) => items.length > 0)
        .map(([title, items, risk]) => (
          <div key={title}>
            <h3 className="text-xs font-medium text-ink-2">{title}</h3>
            <ul className="mt-1.5 space-y-1.5 text-sm text-ink">
              {items.map((item) => (
                <li key={item} className="flex gap-2">
                  {risk ? (
                    <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-ink" />
                  ) : (
                    <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                  )}
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

export const hasPoints = (intel: DealIntel) =>
  intel.painPoints.length + intel.talkingPoints.length + intel.risks.length > 0;

/** The research artifacts it came from, each opened in a new tab. */
export function SourceLinks({ sources }: { sources: DealIntel["sources"] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {sources.map((source) => (
        <li key={source.url}>
          {isArtifactUrl(source.url) ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-start gap-1.5 rounded-sm text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {source.title}
              <ExternalLinkIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <span className="text-ink-2">{source.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
