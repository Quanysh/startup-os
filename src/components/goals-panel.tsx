"use client";

import { useMutation, useQuery } from "convex/react";
import {
  ArrowRightIcon,
  CheckCheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { GOAL_TARGET_AREAS } from "@convex/lib/roles";
import { Panel, fieldClass, outlineButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompany } from "@/components/company-provider";
import { PanelHeading } from "@/components/dashboard/section";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, manyCompanies, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { canOpen } from "@/lib/nav";
import { cn } from "@/lib/utils";

type Status = Doc<"goals">["status"];
type Goal = {
  id: Id<"goals">;
  title: string;
  status: Status;
  company?: CompanyId | null;
  cash?: boolean;
  owner?: { email: string; name: string | null } | null;
  ownerBot?: string | null;
  target?: string | null;
  dueOn?: string | null;
};
/** What is linked to a goal; null is a count the viewer is not given (not zero). */
type Links = { tasks: number; proposals: number | null; deals: number | null; handoffs: number | null };
type Details = { ownerEmail: string; ownerBot: string; target: string; dueOn: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-12-31" → "Dec 31". */
const dayLabel = (day: string) => {
  const [, month, date] = day.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1] ?? ""} ${date}`;
};
const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
/** The person's initial, for the owner's round avatar. */
const initialOf = (owner: { email: string; name: string | null }) =>
  (owner.name ?? owner.email).trim().charAt(0).toUpperCase();

const STATUS: Record<Status, { label: string; icon: LucideIcon; tone: string }> = {
  on_track: { label: "On track", icon: CircleCheckIcon, tone: "text-good" },
  at_risk: { label: "At risk", icon: TriangleAlertIcon, tone: "text-watch" },
  off_track: { label: "Off track", icon: CircleXIcon, tone: "text-weak" },
  done: { label: "Done", icon: CheckCheckIcon, tone: "text-ink-3" },
};

const iconButton =
  "shrink-0 rounded-full p-1.5 text-ink-3 outline-none hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50";
const textButton =
  "shrink-0 rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** "2026-Q4" → "Q4 2026". */
const quarterLabel = (quarter: string) => quarter.split("-").reverse().join(" ");

/**
 * The quarter's few priorities, each with a status the owner sets by hand.
 * Frameworks that work at this stage keep the list to between three and
 * seven; past that the panel says so rather than refusing.
 *
 * A viewer without the `review` area reads the list and each status, with
 * nothing to add, rename, set or remove: Convex would refuse each of those.
 */
export function GoalsPanel({ quarter, summary = false }: { quarter: string; summary?: boolean }) {
  // The company in view's goals and the shared ones; with none chosen, every
  // company the viewer is on.
  const company = useCompany();
  const goals = useQuery(api.goals.list, company === null ? { quarter } : { quarter, company }) as
    | Goal[]
    | undefined;
  // Whose a new goal is: the company in view's unless "Both companies" is chosen.
  const [whose, setWhose] = useState<"company" | "both">("company");
  const create = useMutation(api.goals.create);
  const update = useMutation(api.goals.update);
  const remove = useMutation(api.goals.remove);
  // The Dashboard's is a read-only summary that leads to Goals and targets,
  // where the goals are changed (with the review area).
  const viewer = useViewer();
  const editable = viewer.can("review") && !summary;
  // A target is a figure: the Scorecard's or Finance's (`GOAL_TARGET_AREAS`).
  // Anyone else is sent none, so is offered no field and sends none back.
  const seesTarget = GOAL_TARGET_AREAS.some((area) => viewer.can(area));
  // What is linked to each goal, the people a goal can be given to (the
  // board's list) and the owner's bots: only where the goals are worked on.
  const links = useQuery(
    api.goals.links,
    summary ? "skip" : company === null ? { quarter } : { quarter, company },
  ) as Record<string, Links> | undefined;
  const [editing, setEditing] = useState<{ id: Id<"goals">; company: CompanyId | null; details: Details } | null>(null);
  const people = useQuery(
    api.team.assignable,
    editing === null || !viewer.can("board") ? "skip" : editing.company === null ? {} : { company: editing.company },
  ) as { email: string; name: string | null }[] | undefined;
  // The bots' ids and names; their usage counts are not read here, so no day is asked about.
  const bots = useQuery(api.bots.list, summary || !viewer.isOwner ? "skip" : { today: "" }) as
    | { bots: { botId: string; name: string }[] }
    | undefined;
  const botName = (id: string) => bots?.bots.find((bot) => bot.botId === id)?.name ?? id;

  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  // At most one row is being renamed or confirmed for removal at a time.
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  /** Run a change; if it fails, say why here instead of failing silently. */
  const attempt = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
      return true;
    } catch (failure) {
      setError(messageOf(failure));
      return false;
    }
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const submitted = title;
    if (submitted.trim() === "") return;
    // Cleared before the save so the next goal can be typed straight away.
    setTitle("");
    const ok = await attempt(() =>
      create(
        company === null || whose === "both"
          ? { quarter, title: submitted }
          : { quarter, title: submitted, company },
      ),
    );
    if (!ok) setTitle((current) => (current === "" ? submitted : current));
  };

  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!renaming) return;
    const { id, title: next } = renaming;
    setRenaming(null);
    if (next.trim() === "") return;
    await attempt(() => update({ id: id as Id<"goals">, title: next }));
  };

  const saveDetails = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    const { id, details } = editing;
    setEditing(null);
    const orNull = (value: string) => (value.trim() === "" ? null : value.trim());
    await attempt(() =>
      update({
        id,
        ownerEmail: orNull(details.ownerEmail),
        ownerBot: orNull(details.ownerBot),
        ...(seesTarget ? { target: orNull(details.target) } : null),
        dueOn: orNull(details.dueOn),
      }),
    );
  };

  return (
    <Panel aria-labelledby="goals">
      <PanelHeading id="goals" className="flex items-baseline justify-between text-base">
        {summary && canOpen(viewer.areas, "/goals") ? (
          <Link
            href="/goals"
            className="group inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Goals
            <ArrowRightIcon
              aria-hidden
              className="size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
            />
          </Link>
        ) : (
          "Goals"
        )}
        <span className="text-xs font-normal text-ink-3">{quarterLabel(quarter)}</span>
      </PanelHeading>

      {goals === undefined ? (
        <Skeleton className="mt-4 h-20 rounded-inner" />
      ) : (
        <>
          {goals.length === 0 && (
            <p className="mt-3 text-sm text-ink-2">
              {editable
                ? "No goals for this quarter yet. Three to seven is the useful range: enough to cover what matters, few enough to remember."
                : "No goals for this quarter yet."}
            </p>
          )}

          <ul className="mt-2 divide-y divide-line">
            {goals.map((goal) => {
              const { icon: Icon, tone } = STATUS[goal.status];
              return (
                <li key={goal.id} className="py-2">
                  <div className="flex min-h-8 items-center gap-2">
                    <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />

                    {renaming?.id === goal.id ? (
                      <form onSubmit={rename} className="min-w-0 flex-1">
                        <input
                          autoFocus
                          aria-label="Goal title"
                          value={renaming.title}
                          onChange={(e) => setRenaming({ id: goal.id, title: e.target.value })}
                          onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                          onBlur={() => setRenaming(null)}
                          className={`${fieldClass} h-8`}
                        />
                      </form>
                    ) : (
                      <span
                        className={cn(
                          "min-w-0 flex-1 text-sm text-ink",
                          goal.status === "done" && "text-ink-2 line-through decoration-ink-3",
                        )}
                      >
                        {goal.title}
                        {company !== null && goal.company === null && manyCompanies() && (
                          <span className="ml-2 text-xs text-ink-3">Both companies</span>
                        )}
                        {!editable && goal.cash === true && <span className="ml-2 text-xs text-ink-3">Cash</span>}
                      </span>
                    )}

                    {!editable ? (
                      <span className="shrink-0 text-xs text-ink-2">{STATUS[goal.status].label}</span>
                    ) : removing === goal.id ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-ink-2">
                        Remove?
                        <button
                          type="button"
                          onClick={() => {
                            setRemoving(null);
                            void attempt(() => remove({ id: goal.id }));
                          }}
                          className={cn(textButton, "font-medium text-destructive hover:bg-destructive/10")}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(null)}
                          className={cn(textButton, "hover:bg-surface")}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-pressed={goal.cash === true}
                          aria-label={`Cash goal: ${goal.title}`}
                          title="A cash goal: its proposals are pinned in Cash and runway on Approvals"
                          onClick={() => void attempt(() => update({ id: goal.id, cash: goal.cash !== true }))}
                          className={cn(
                            "h-8 shrink-0 rounded-full border px-2 text-xs font-medium",
                            goal.cash === true
                              ? "border-brand bg-brand-fill text-on-brand"
                              : "border-input bg-panel text-ink-2 hover:bg-surface",
                          )}
                        >
                          Cash
                        </button>
                        <select
                          aria-label={`Status of ${goal.title}`}
                          value={goal.status}
                          onChange={(e) =>
                            void attempt(() =>
                              update({ id: goal.id, status: e.target.value as Status }),
                            )
                          }
                          className="h-8 shrink-0 rounded-full border border-input bg-panel px-2 text-xs text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          {Object.entries(STATUS).map(([value, { label }]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label={`Edit owner and target of ${goal.title}`}
                          aria-expanded={editing?.id === goal.id}
                          onClick={() =>
                            setEditing(
                              editing?.id === goal.id
                                ? null
                                : {
                                    id: goal.id,
                                    company: goal.company ?? null,
                                    details: {
                                      ownerEmail: goal.owner?.email ?? "",
                                      ownerBot: goal.ownerBot ?? "",
                                      target: goal.target ?? "",
                                      dueOn: goal.dueOn ?? "",
                                    },
                                  },
                            )
                          }
                          className={iconButton}
                        >
                          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Rename ${goal.title}`}
                          // Keep focus from leaving the field before it exists.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setRenaming({ id: goal.id, title: goal.title })}
                          className={iconButton}
                        >
                          <PencilIcon aria-hidden className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${goal.title}`}
                          onClick={() => setRemoving(goal.id)}
                          className={cn(iconButton, "hover:text-destructive")}
                        >
                          <Trash2Icon aria-hidden className="size-3.5" />
                        </button>
                      </>
                    )}
                  </div>

                  {!summary && <GoalMeta goal={goal} links={links?.[goal.id]} botName={botName} />}

                  {editing?.id === goal.id && (
                    <form
                      onSubmit={saveDetails}
                      aria-label={`Owner and target of ${goal.title}`}
                      className="mt-2 grid gap-2 rounded-inner bg-surface p-3 sm:grid-cols-2"
                    >
                      <label className="grid gap-1 text-xs text-ink-2">
                        Owner
                        <select
                          aria-label="Owner"
                          value={editing.details.ownerEmail}
                          onChange={(e) => setEditing({ ...editing, details: { ...editing.details, ownerEmail: e.target.value } })}
                          className={`${fieldClass} h-9`}
                        >
                          <option value="">Nobody</option>
                          {/* The one already set stays listed even before the list arrives. */}
                          {goal.owner && !people?.some((p) => p.email === goal.owner!.email) && (
                            <option value={goal.owner.email}>{goal.owner.name ?? goal.owner.email}</option>
                          )}
                          {people?.map((person) => (
                            <option key={person.email} value={person.email}>
                              {person.name ?? person.email}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs text-ink-2">
                        Bot
                        <select
                          aria-label="Bot"
                          value={editing.details.ownerBot}
                          onChange={(e) => setEditing({ ...editing, details: { ...editing.details, ownerBot: e.target.value } })}
                          className={`${fieldClass} h-9`}
                        >
                          <option value="">No bot</option>
                          {goal.ownerBot && !bots?.bots.some((b) => b.botId === goal.ownerBot) && (
                            <option value={goal.ownerBot}>{goal.ownerBot}</option>
                          )}
                          {bots?.bots.map((bot) => (
                            <option key={bot.botId} value={bot.botId}>
                              {bot.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {seesTarget && (
                        <label className="grid gap-1 text-xs text-ink-2">
                          Target
                          <input
                            aria-label="Target"
                            value={editing.details.target}
                            maxLength={120}
                            placeholder="What done looks like: v2 live at 3 pilot clinics"
                            onChange={(e) => setEditing({ ...editing, details: { ...editing.details, target: e.target.value } })}
                            className={`${fieldClass} h-9`}
                          />
                        </label>
                      )}
                      <label className="grid gap-1 text-xs text-ink-2">
                        Due
                        <input
                          aria-label="Due"
                          type="date"
                          value={editing.details.dueOn}
                          onChange={(e) => setEditing({ ...editing, details: { ...editing.details, dueOn: e.target.value } })}
                          className={`${fieldClass} h-9`}
                        />
                      </label>
                      <div className="flex justify-end gap-2 sm:col-span-2">
                        <button type="button" onClick={() => setEditing(null)} className={cn(textButton, "hover:bg-panel")}>
                          Cancel
                        </button>
                        <button type="submit" className={outlineButtonClass}>
                          Save
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>

          {removing !== null && (
            <p className="mt-1 text-xs text-ink-3">
              Cards linked to this goal stay on the board, without the link.
            </p>
          )}

          {editable && (
            <form onSubmit={add} className="mt-3 flex flex-wrap gap-2 sm:flex-nowrap">
              {company !== null && manyCompanies() && (
                <select
                  aria-label="Whose goal"
                  value={whose}
                  onChange={(e) => setWhose(e.target.value as "company" | "both")}
                  className="h-9 shrink-0 rounded-full border border-input bg-panel px-3 text-xs text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="company">{COMPANIES[company].name}</option>
                  <option value="both">Both companies</option>
                </select>
              )}
              <input
                aria-label="New goal"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Add a goal for this quarter"
                className={`${fieldClass} h-9`}
              />
              <button
                type="submit"
                aria-label="Add goal"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-fill text-on-brand outline-none hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <PlusIcon aria-hidden className="size-4" />
              </button>
            </form>
          )}

          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {editable && goals.length > 7 && (
            <p className="mt-2 text-xs text-ink-2">
              {goals.length} goals is a long list for one quarter. Consider which ones are
              really tasks.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * Under a goal's title: its owner (a round initial and the name), its bot,
 * target and due day, and how much is linked to it. A count the viewer is not
 * given (null) is left out rather than shown as zero.
 */
function GoalMeta({
  goal,
  links,
  botName,
}: {
  goal: Goal;
  links: Links | undefined;
  botName: (id: string) => string;
}) {
  const parts: React.ReactNode[] = [];
  if (goal.owner) {
    parts.push(
      <span key="owner" className="inline-flex items-center gap-1.5 text-ink">
        <span
          aria-hidden
          className="inline-flex size-5 items-center justify-center rounded-full bg-brand/12 text-[10px] font-medium text-brand"
        >
          {initialOf(goal.owner)}
        </span>
        {goal.owner.name ?? goal.owner.email}
      </span>,
    );
  }
  if (goal.ownerBot) parts.push(<span key="bot">Bot: {botName(goal.ownerBot)}</span>);
  if (goal.target) parts.push(<span key="target">Target: {goal.target}</span>);
  if (goal.dueOn) parts.push(<span key="due">Due {dayLabel(goal.dueOn)}</span>);
  if (links) {
    parts.push(<span key="tasks">{counted(links.tasks, "task")}</span>);
    if (links.proposals !== null) parts.push(<span key="proposals">{counted(links.proposals, "proposal")}</span>);
    if (links.deals !== null) parts.push(<span key="deals">{counted(links.deals, "deal")}</span>);
    if (links.handoffs !== null) parts.push(<span key="handoffs">{counted(links.handoffs, "handoff")}</span>);
  }
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-ink-2">{parts}</p>
  );
}
