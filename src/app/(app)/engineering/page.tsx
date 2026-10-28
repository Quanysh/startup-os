"use client";

import { useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import {
  PR_APPROVED_STUCK_AFTER_DAYS,
  PR_CLOSED_SHOWN_DAYS,
  PR_DRAFT_STUCK_AFTER_DAYS,
  PR_STUCK_AFTER_DAYS,
} from "@convex/lib/limits";
import { periodStart } from "@convex/lib/periods";
import { AttentionList } from "@/components/attention-list";
import { useCompany } from "@/components/company-provider";
import { EngineeringFigures } from "@/components/engineering/figures-section";
import { FlowPanel } from "@/components/engineering/flow-panel";
import { OWNER_CAPTION, OwnerTable } from "@/components/engineering/owner-table";
import { PullFilters, PullTable } from "@/components/engineering/pull-table";
import { StuckStrip } from "@/components/engineering/stuck-strip";
import { Note } from "@/components/finance/notes";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { Panel, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import {
  NO_FILTERS,
  columnsOf,
  filterItems,
  ownerRows,
  placeAll,
  readView,
  sortItems,
  writeView,
  type View,
} from "@/lib/engineering/view";
import { marketsOf } from "@/lib/company";
import { stuckCount } from "@/lib/engineering/flow";
import { listAgeDays, weeklyCounts } from "@/lib/metrics/apollo";
import { attentionItems, type Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";

function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-28 rounded-card" />
      <Skeleton className="h-96 rounded-card" />
      <Skeleton className="h-44 rounded-card" />
    </div>
  );
}

/** A block of the page: a panel named by its heading. */
function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const id = useId();
  return (
    <Panel aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="text-base">
        {title}
      </h2>
      {note !== undefined && <p className="mt-1 max-w-3xl text-xs text-ink-2">{note}</p>}
      <div className="mt-4">{children}</div>
    </Panel>
  );
}

/** A block with nothing to show yet, or nothing at all: one quiet sentence. */
const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-ink-3">{children}</p>
);

/**
 * Last finished week's merged count across the companies in view: null
 * unless it is known for each of them, since a sum of what is known would be
 * a smaller number than the truth.
 */
function mergedLastWeekOf(tiles: readonly Tile[], markets: readonly string[], now: number): number | null {
  let total = 0;
  for (const market of markets) {
    const series = tiles.find((tile) => tile.key === "prs_merged" && tile.scope === market)?.series ?? [];
    const lastWeek = weeklyCounts(series, periodStart("week", now)).lastWeek;
    if (lastWeek === null) return null;
    total += lastWeek.value;
  }
  return markets.length === 0 ? null : total;
}

/** Reads the address, so it sits under the page's Suspense boundary. */
function Engineering() {
  const company = useCompany();
  const { can, companies } = useViewer();
  const allowed = can("engineering");
  // Convex sends only the caller's companies' rows, and refuses both queries
  // without the engineering area, so neither is sent without it.
  const pulls = useQuery(api.workTools.pullRequests, allowed ? {} : "skip");
  const repositories = useQuery(api.workTools.engineering, allowed ? {} : "skip");
  const data = useScorecard();
  const now = useNow();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (pulls === undefined || data === undefined || now === null) return <Loading />;

  // The view is the address: filters and sort are read from it and written
  // to it, so a view can be shared and the back button undoes a change.
  const view = readView(new URLSearchParams(params.toString()));
  const show = (next: View) => {
    const query = writeView(next);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  // The companies whose engineering is in view: the one chosen, or each the
  // viewer is on where none is.
  const markets = marketsOf(company).filter((id) => companies.includes(id));
  const all = placeAll(
    pulls.rows.filter((row) => markets.includes(row.company)),
    now,
  );
  const owners = [...new Map(all.map((item) => [item.owner.key, item.owner])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const repos = [...new Set(all.map((item) => item.pull.repoId))].sort((a, b) => a.localeCompare(b));
  // One person's work, where a person is chosen: the flow and the strip
  // follow the owner; the table follows every filter.
  const person = view.filters.owner;
  const scoped = filterItems(all, { ...NO_FILTERS, owner: person });
  const listed = sortItems(filterItems(all, view.filters), view.sort);
  const personName = owners.find((owner) => owner.key === person)?.name ?? null;

  const read = pulls.readAt !== null;
  const age = pulls.readAt === null ? null : listAgeDays(pulls.readAt, now);
  const failures = attentionItems(data.tiles, data.sources, now).filter(
    (item) => item.severity === "error" && item.id === "source:github",
  );

  return (
    <>
      {failures.length > 0 && <AttentionList items={failures} />}
      {age !== null && (
        <div className="text-xs leading-relaxed text-ink-2">
          <Note caution>
            {/* When it was read is the header's to say, once. */}
            Out of date: stages and ages below are as of GitHub&apos;s last read, given above.
          </Note>
        </div>
      )}
      {person !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-inner bg-info-soft px-4 py-2 text-sm text-info-ink">
          <p>{`Showing ${personName === null ? "one person" : personName}'s pull requests.`}</p>
          <button
            type="button"
            onClick={() => show({ ...view, filters: { ...view.filters, owner: null } })}
            className={cn(quietButtonClass, "h-8 px-3 text-info-ink")}
          >
            Show everyone
          </button>
        </div>
      )}

      <Block title="Stuck and piling up">
        {read ? (
          <StuckStrip items={scoped} mergedLastWeek={mergedLastWeekOf(data.tiles, markets, now)} />
        ) : (
          <Quiet>What is stuck arrives with the daily GitHub read.</Quiet>
        )}
      </Block>

      <Block title="The flow">
        {read ? (
          <FlowPanel
            columns={columnsOf(scoped)}
            closed={scoped.filter((item) => item.placed.stage === "closed").length}
          />
        ) : (
          <Quiet>The flow arrives with the daily GitHub read.</Quiet>
        )}
      </Block>

      <Block title="By owner" note={OWNER_CAPTION}>
        {!read ? (
          <Quiet>Who owns what arrives with the daily GitHub read.</Quiet>
        ) : ownerRows(all, now).length === 0 ? (
          <Quiet>Nobody has an open pull request.</Quiet>
        ) : (
          <OwnerTable
            rows={ownerRows(all, now)}
            selected={person}
            onSelect={(owner) => show({ ...view, filters: { ...view.filters, owner } })}
          />
        )}
      </Block>

      <Block title="All pull requests">
        {!read ? (
          <Quiet>The pull requests arrive with the daily GitHub read.</Quiet>
        ) : all.length === 0 ? (
          <Quiet>
            {`No pull request is open, and none was merged or closed in the last ${PR_CLOSED_SHOWN_DAYS} days.`}
          </Quiet>
        ) : (
          <div className="space-y-4">
            <PullFilters
              filters={view.filters}
              owners={owners}
              repos={repos}
              onChange={(filters) => show({ ...view, filters })}
            />
            <p className="text-xs text-ink-2">
              {`Showing ${listed.length} of ${all.length}.${view.sort === null ? " Sorted: stuck first, then the oldest." : ""}`}
            </p>
            {listed.length === 0 ? (
              <Quiet>No pull request matches these filters.</Quiet>
            ) : (
              <PullTable items={listed} view={view} now={now} onSort={(sort) => show({ ...view, sort })} />
            )}
          </div>
        )}
      </Block>

      {/* The numbers the flow is not: counts by week and by repository. */}
      {markets.map((id) => (
        <EngineeringFigures
          key={id}
          tiles={data.tiles}
          now={now}
          lists={repositories}
          company={id}
          stuck={stuckCount(pulls, id, now)}
          named={markets.length > 1}
        />
      ))}

      <div className="max-w-3xl space-y-1.5 text-xs leading-relaxed text-ink-2">
        <p>
          Read from GitHub once a day: a pull request&apos;s title, who opened it, who is asked to review,
          its dates, review decision and check result. Never code, a diff, a description, a comment or a
          commit message. Pull requests opened by bots are left out, and merged or closed ones are kept
          for {PR_CLOSED_SHOWN_DAYS} days. Dates are UTC days. Nothing here is written to GitHub.
        </p>
        <p>
          {`Stuck means: waiting more than ${PR_STUCK_AFTER_DAYS} days for a review, changes requested with no update for more than ${PR_STUCK_AFTER_DAYS} days, approved and unmerged for more than ${PR_APPROVED_STUCK_AFTER_DAYS} days, a draft untouched for more than ${PR_DRAFT_STUCK_AFTER_DAYS} days, or failing checks on one that is not a draft.`}
        </p>
      </div>
    </>
  );
}

export default function EngineeringPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Engineering"
        purpose="Where each pull request stands, what is stuck, and who owns it."
        aside={<PageFreshness page="engineering" />}
      />
      <Suspense fallback={<Loading />}>
        <Engineering />
      </Suspense>
    </div>
  );
}
