"use client";

import { useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { CostCategory } from "@convex/lib/costs";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { Panel, primaryButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, DEFAULT_COMPANY } from "@/lib/company";
import { costMonthOf, readView, writeView, type View } from "@/lib/costs/view";
import { lastChange } from "@/lib/source-freshness";
import { CostCharts } from "./cost-charts";
import { HeadTiles } from "./head-tiles";
import { LineEditor } from "./line-editor";
import { LinesTable } from "./lines-table";
import { PlannedBurn } from "./planned-burn";
import { QuickAdd, type Line } from "./shared";

/** What someone without the Costs page reads in its place. */
export const COSTS_NOT_YOURS =
  "Only the owner, and people the owner gives the Costs page, can open this page.";

/** What the editor is open on: a line, a new line, or a new line from a chip. */
type Editing = { line: Line | null; preset?: { name: string; category: CostCategory } };

/**
 * The costs page, for the company in view: what it pays for besides pay, what
 * that comes to a month, and the planned burn. It is the `costs` area's: the
 * owner's, and a teammate's the owner ticked it for by name, who is sent only
 * the companies they are on.
 *
 * Anyone else gets a line and no query: every costs function refuses them,
 * and a refused query breaks the page. That is presentation; the refusal
 * itself is the server's (`memberQuery("costs")` and `requireCompany`).
 */
export function CostsView() {
  const viewer = useViewer();
  const allowed = viewer.can("costs");
  const company = useCompany() ?? DEFAULT_COMPANY;
  const now = useNow();
  // The month is the browser's to say: a query never reads the clock.
  const month = now === null ? null : costMonthOf(now);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [editing, setEditing] = useState<Editing | null>(null);

  const lines = useQuery(api.costs.list, allowed ? { company } : "skip");
  const summary = useQuery(
    api.costs.summary,
    allowed && month !== null ? { company, month } : "skip",
  );

  if (!allowed) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-2xl sm:text-3xl">Costs</h1>
        </header>
        <Panel>
          <p className="text-sm text-ink-2">{COSTS_NOT_YOURS}</p>
        </Panel>
      </div>
    );
  }

  const view = readView(new URLSearchParams(params.toString()));
  const show = (next: View) => {
    const query = writeView(next);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  const ready = lines !== undefined && summary !== undefined && month !== null && now !== null;

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl">Costs</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            What {COMPANIES[company].name} pays for besides pay: cloud, subscriptions, office rent
            and the rest, so the monthly run-rate is known and not a surprise. Lines somebody typed,
            not what the bank shows. No card or account numbers belong here.{" "}
            {viewer.isOwner
              ? "Only you can open this page: payroll and costs are the owner's alone."
              : "The owner gave you this page."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
          {/* Typed in here: when a line the viewer reads last changed. */}
          <TypedFreshness
            label="Cost lines"
            at={lines === undefined ? undefined : lastChange(lines.map((line) => ({ changedAt: line.updatedAt })))}
          />
          {ready && lines.length > 0 && (
            <button
              type="button"
              onClick={() => setEditing({ line: null })}
              className={`${primaryButtonClass} shrink-0`}
            >
              <PlusIcon aria-hidden className="size-4" />
              Add a cost
            </button>
          )}
        </div>
      </header>

      {!ready ? (
        <Skeleton className="h-48 rounded-card" />
      ) : lines.length === 0 ? (
        <Panel aria-label="No costs yet">
          <p className="max-w-2xl text-sm text-ink">
            No costs yet. Add what {COMPANIES[company].name} pays for each month to see the
            run-rate, starting from a common line or from a blank one.
          </p>
          <div className="mt-4">
            <QuickAdd onPick={(preset) => setEditing({ line: null, preset })} />
          </div>
          <button
            type="button"
            onClick={() => setEditing({ line: null })}
            className={`${primaryButtonClass} mt-4`}
          >
            <PlusIcon aria-hidden className="size-4" />
            Add a cost
          </button>
        </Panel>
      ) : (
        <>
          <HeadTiles summary={summary} />
          <PlannedBurn company={company} summary={summary} now={now} />
          <CostCharts summary={summary} />
          <Panel aria-labelledby="cost-lines">
            <h2 id="cost-lines" className="text-base">
              Cost lines
            </h2>
            <div className="mt-4">
              <LinesTable
                lines={lines}
                month={month}
                view={view}
                onView={show}
                onEdit={(line) => setEditing({ line })}
              />
            </div>
          </Panel>
        </>
      )}

      {editing !== null && month !== null && (
        <LineEditor
          // A new editor for each opening, so one line's text never shows on another.
          key={editing.line?.id ?? `new:${editing.preset?.name ?? ""}`}
          company={company}
          line={editing.line}
          preset={editing.preset}
          month={month}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
