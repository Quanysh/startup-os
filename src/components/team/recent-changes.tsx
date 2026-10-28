"use client";

import { useQuery } from "convex/react";
import { useId, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { Panel, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { localIsoDate } from "@/lib/dates";
import { companyNames } from "./company-checks";
import { pageNames, payAndCostsNames, sensitiveNames } from "./page-checks";

type Change = FunctionReturnType<typeof api.team.changes>["rows"][number];
type State = NonNullable<Change["before"]>;

const VERB: Record<Change["kind"], string> = {
  add: "added",
  update: "changed",
  remove: "removed",
};

/** Said where the list is empty. */
export const NO_CHANGES =
  "Nothing yet. What someone you gave the Team page adds, changes or removes is listed here. Your own changes are listed only where you gave someone a sensitive page or put them on another company.";

/**
 * What someone had at one moment: role, companies, pages, the sensitive ones
 * marked. Payroll and Costs show only in a change recorded before they were
 * the owner's alone, marked sensitive as they were then.
 */
function stateWords(state: State): string {
  const areas: readonly Area[] = state.areas;
  const pages = [
    ...pageNames(areas),
    ...[...payAndCostsNames(areas), ...sensitiveNames(areas)].map((name) => `${name} (sensitive)`),
  ];
  return [
    state.roleName,
    companyNames(state.companies),
    pages.length === 0 ? "no pages" : pages.join(", "),
  ].join(" · ");
}

/** Who did it. Someone since removed, whose row no longer says, is said so. */
function actorWords(actor: Change["actor"]): string {
  if (actor === null) return "A removed teammate";
  return actor.name === null ? actor.email : `${actor.name} (${actor.email})`;
}

/** One change: who, what, whom, when, and what they had before and after. */
function ChangeItem({ change }: { change: Change }) {
  return (
    <li className="py-2.5 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-medium break-all text-ink">
          {actorWords(change.actor)} {VERB[change.kind]}{" "}
          {change.person?.email ?? "someone who had not signed in"}
        </span>
        <span className="font-num text-xs text-ink-3">{localIsoDate(change.at)}</span>
      </p>
      {change.before !== null && (
        <p className="mt-0.5 text-xs text-ink-2">Before: {stateWords(change.before)}</p>
      )}
      {change.after !== null && (
        <p className="mt-0.5 text-xs text-ink-2">After: {stateWords(change.after)}</p>
      )}
      {change.telegramChanged && (
        <p className="mt-0.5 text-xs text-ink-2">Their Telegram username was changed too.</p>
      )}
    </li>
  );
}

/**
 * Twenty changes: the latest, or the twenty before a point. The last page on
 * screen offers the one before it, so every change can be reached.
 */
function ChangesPage({
  before,
  last,
  onMore,
}: {
  before: number | undefined;
  last: boolean;
  onMore: (next: number) => void;
}) {
  const page = useQuery(api.team.changes, before === undefined ? {} : { before });
  const keptId = useId();
  if (page === undefined) return <Skeleton className="mt-3 h-16 rounded-inner" />;
  const { next } = page;
  return (
    <>
      {before === undefined && page.widened.length > 0 && (
        <div className="mt-3 rounded-inner border border-line p-3">
          <h3 id={keptId} className="text-sm font-medium text-ink">
            Sensitive pages and companies given
          </h3>
          <p className="mt-0.5 text-xs text-ink-2">
            Kept here whatever their age, and however many changes came after: the latest twenty.
          </p>
          <ul aria-labelledby={keptId} className="mt-1 divide-y divide-line">
            {page.widened.map((change) => (
              <ChangeItem key={change.id} change={change} />
            ))}
          </ul>
        </div>
      )}
      {before === undefined && page.rows.length === 0 ? (
        <p className="mt-3 max-w-2xl text-sm text-ink-3">{NO_CHANGES}</p>
      ) : (
        <ul className={before === undefined ? "mt-3 divide-y divide-line" : "divide-y divide-line border-t border-line"}>
          {page.rows.map((change) => (
            <ChangeItem key={change.id} change={change} />
          ))}
        </ul>
      )}
      {last && next !== null && (
        <button type="button" onClick={() => onMore(next)} className={`${quietButtonClass} mt-3`}>
          Show more
        </button>
      )}
    </>
  );
}

/**
 * What was changed on the team, for the owner alone (`team.changes` refuses
 * anyone else, so only the owner's page renders this). Every word here but an
 * address and a name is fixed: the record holds no text anyone typed.
 */
export function RecentChanges() {
  // Where each further page starts: one more for each "Show more".
  const [older, setOlder] = useState<number[]>([]);
  const more = (next: number) => setOlder((pages) => (pages.includes(next) ? pages : [...pages, next]));
  return (
    <Panel aria-labelledby="team-changes">
      <h2 id="team-changes" className="text-base">
        Recent changes
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        What the people you gave the Team page did to the team, newest first, twenty at a time.
        Only you can read this.
      </p>
      <ChangesPage before={undefined} last={older.length === 0} onMore={more} />
      {older.map((before, index) => (
        <ChangesPage key={before} before={before} last={index === older.length - 1} onMore={more} />
      ))}
    </Panel>
  );
}
