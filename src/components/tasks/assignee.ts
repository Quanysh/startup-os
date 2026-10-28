import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { CompanyId } from "@/lib/company";

// Who a task is for, as the board shows and picks it, and which tasks a
// viewer is looking at. Pure, so the board's arithmetic can be tested alone.

type Assignee = FunctionReturnType<typeof api.tasks.board>["backlog"][number]["assignee"];
export type Person = FunctionReturnType<typeof api.team.assignable>[number];

/**
 * The server's sentence for a task whose assignee is not on the company it
 * is being moved to (convex/tasks.ts). The forms stop that save themselves
 * and say the same thing.
 */
export const ASSIGNEE_NOT_ON_COMPANY =
  "The person this task is assigned to is not on that company. Unassign it first.";

const localPart = (email: string) => email.split("@")[0]!;

/** A person's name, or the part of their address before the @. */
export const personLabel = (person: { email: string; name: string | null }) =>
  person.name ?? localPart(person.email);

/**
 * How an assignee reads on a card. The server names only a teammate the
 * viewer shares a company with; the other two are never named here either.
 */
export function assigneeLabel(assignee: Assignee): string | null {
  if (assignee === null) return null;
  if (assignee.status === "teammate") return personLabel(assignee);
  return assignee.status === "removed" ? "Removed teammate" : "Someone on the other company";
}

/** Two letters for the chip: first and last word, or the start of a single one. */
export function initialsOf(label: string): string {
  const words = label.split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * What an assignee picker holds: nobody (null), a person by address, or
 * `KEPT` for an assignee who cannot be picked again (removed, or on the other
 * company) and stays on the task until someone else is chosen.
 */
export type Selection = { value: string; label: string } | null;
export const KEPT = "kept";

export function selectionOf(assignee: Assignee): Selection {
  if (assignee === null) return null;
  return assignee.status === "teammate"
    ? { value: assignee.email, label: personLabel(assignee) }
    : { value: KEPT, label: assigneeLabel(assignee)! };
}

/**
 * Whether the person picked is missing from the list for the task's company.
 * Never while the list is loading: the server has the last word then. A bot
 * id has no "@" and is not in that list; the server still accepts it.
 */
export function isStranded(selection: Selection, people: readonly Person[] | undefined): boolean {
  if (selection === null || people === undefined || !selection.value.includes("@")) return false;
  return !people.some((person) => person.email === selection.value);
}

export type TaskFilter = "mine" | "everyone";

/**
 * The cards on screen: those of the company in view and the shared ones
 * (everything when no company is in view), and under "mine" only those
 * assigned to the viewer's address.
 */
export function visibleTasks<
  T extends { company: CompanyId | null; assignee: { email: string | null } | null },
  B extends Record<string, T[]>,
>(
  board: B,
  view: { company: CompanyId | null; filter: TaskFilter; email: string | null },
): B {
  const me = view.email?.toLowerCase() ?? null;
  const shown = (task: T) =>
    (view.company === null || task.company === null || task.company === view.company) &&
    (view.filter === "everyone" || (me !== null && task.assignee?.email?.toLowerCase() === me));
  return Object.fromEntries(
    Object.entries(board).map(([column, tasks]) => [column, tasks.filter(shown)]),
  ) as B;
}

/**
 * Where a card dropped at `index` among the cards on screen sits among all
 * the cards the server sent for that column, which is what `tasks.move`
 * counts. Both indexes leave the moved card out. The card lands just above
 * the one on screen at that place, or just after the last one on screen; with
 * none on screen it goes to the column's end, as the server does for cards it
 * hides from the caller.
 */
export function unfilteredIndex(
  all: readonly string[],
  shown: readonly string[],
  id: string,
  index: number,
): number {
  const others = all.filter((other) => other !== id);
  const seen = shown.filter((other) => other !== id);
  const at = Math.min(Math.max(index, 0), seen.length);
  if (at < seen.length) return others.indexOf(seen[at]!);
  return seen.length > 0 ? others.indexOf(seen.at(-1)!) + 1 : others.length;
}
