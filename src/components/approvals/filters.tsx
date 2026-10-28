"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { COMPANIES, companyIds, manyCompanies } from "@convex/lib/company";
import { fieldClass } from "@/components/panel";
import {
  DECIDED_LABELS,
  DECIDED_STATUSES,
  INBOX_TYPES,
  INBOX_URGENCIES,
  TYPE_LABELS,
  URGENCY_LABELS,
  readView,
  whoLabel,
  whoOfKey,
  writeView,
  type View,
} from "@/lib/approvals/inbox";
import { cn } from "@/lib/utils";

/** The page's view (its tab and filters), read from the address and written back to it. */
export function useView(): [View, (next: View) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = readView(new URLSearchParams(params.toString()));
  const setView = (next: View) => {
    const query = writeView(next);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  return [view, setView];
}

const label = "block text-xs font-medium text-ink-2";

/**
 * The same filters on both tabs of /approvals: company, agent or bot, goal,
 * type and urgency; on "Decided", how it ended too.
 */
export function Filters({
  view,
  setView,
  agents,
  goals,
}: {
  view: View;
  setView: (next: View) => void;
  agents: readonly string[];
  goals: readonly { id: string; title: string }[];
}) {
  return (
    <>
      {/* With one company there is nothing to filter by. */}
      {manyCompanies() && (
        <label className={label}>
          Company
          <select
            value={view.company ?? ""}
            onChange={(event) => setView({ ...view, company: (event.target.value || null) as View["company"] })}
            className={cn(fieldClass, "mt-1 h-9 w-28")}
          >
            <option value="">Both</option>
            {companyIds().map((company) => (
              <option key={company} value={company}>
                {COMPANIES[company].name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={label}>
        Agent
        <select
          value={view.agent ?? ""}
          onChange={(event) => setView({ ...view, agent: event.target.value || null })}
          className={cn(fieldClass, "mt-1 h-9 w-44")}
        >
          <option value="">Every agent</option>
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {whoLabel(whoOfKey(agent))}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        Goal
        <select
          value={view.goal ?? ""}
          onChange={(event) => setView({ ...view, goal: event.target.value || null })}
          className={cn(fieldClass, "mt-1 h-9 w-44")}
        >
          <option value="">Every goal</option>
          <option value="none">No goal</option>
          {goals.map((goal) => (
            <option key={goal.id} value={goal.id}>
              {goal.title}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        Type
        <select
          value={view.type ?? ""}
          onChange={(event) => setView({ ...view, type: (event.target.value || null) as View["type"], kind: null })}
          className={cn(fieldClass, "mt-1 h-9 w-40")}
        >
          <option value="">Every type</option>
          {INBOX_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        Urgency
        <select
          value={view.urgency ?? ""}
          onChange={(event) => setView({ ...view, urgency: (event.target.value || null) as View["urgency"] })}
          className={cn(fieldClass, "mt-1 h-9 w-36")}
        >
          <option value="">Any urgency</option>
          {INBOX_URGENCIES.map((urgency) => (
            <option key={urgency} value={urgency}>
              {URGENCY_LABELS[urgency]}
            </option>
          ))}
        </select>
      </label>
      {view.tab === "decided" && (
        <label className={label}>
          Decision
          <select
            value={view.decision ?? ""}
            onChange={(event) => setView({ ...view, decision: (event.target.value || null) as View["decision"] })}
            className={cn(fieldClass, "mt-1 h-9 w-48")}
          >
            <option value="">Every decision</option>
            {DECIDED_STATUSES.map((status) => (
              <option key={status} value={status}>
                {DECIDED_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
