"use client";

import { useQuery } from "convex/react";
import { useId } from "react";
import { api } from "@convex/_generated/api";
import { fieldClass } from "@/components/panel";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { cn } from "@/lib/utils";
import { personLabel, type Person, type Selection } from "./assignee";

/**
 * The people a task of this company can be assigned to (a shared task, with
 * no company: anyone the viewer works with). Read again when the company
 * changes; undefined while loading or when `enabled` is false.
 */
export function useAssignable(company: CompanyId | null, enabled = true) {
  return useQuery(api.team.assignable, !enabled ? "skip" : company === null ? {} : { company });
}

/**
 * Who a task is for: "Unassigned", then the people it can go to. A selection
 * that is not in the list keeps an option of its own, so re-reading the list
 * never silently changes who holds the task. When that person is `stranded`
 * (not on the company the task is being given to), the option and a line
 * under the field say so; the form refuses the save.
 */
export function AssigneePicker({
  id,
  "aria-label": ariaLabel,
  selection,
  onChange,
  people,
  company,
  stranded,
  className,
}: {
  id?: string;
  "aria-label"?: string;
  selection: Selection;
  onChange: (selection: Selection) => void;
  people: readonly Person[] | undefined;
  company: CompanyId | null;
  stranded: boolean;
  className?: string;
}) {
  const noteId = useId();
  const listed = selection !== null && people?.some((p) => p.email === selection.value);
  const flagged = stranded && company !== null;

  return (
    <>
      <select
        id={id}
        aria-label={ariaLabel}
        aria-invalid={flagged || undefined}
        aria-describedby={flagged ? noteId : undefined}
        value={selection?.value ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "") return onChange(null);
          const person = people?.find((p) => p.email === value);
          if (person) onChange({ value, label: personLabel(person) });
        }}
        className={cn(fieldClass, className)}
      >
        <option value="">Unassigned</option>
        {people?.map((person) => (
          <option key={person.email} value={person.email}>
            {personLabel(person)}
          </option>
        ))}
        {selection !== null && !listed && (
          <option value={selection.value}>
            {selection.label}
            {flagged && ` (not on ${COMPANIES[company].name})`}
          </option>
        )}
      </select>
      {flagged && (
        <p id={noteId} className="text-xs text-destructive">
          Not on {COMPANIES[company].name}. Unassign the task, or pick someone who is.
        </p>
      )}
    </>
  );
}

/**
 * Which company a task belongs to, for a viewer on more than one: "Both
 * companies" (a shared task, seen by everyone with the board) or one of
 * theirs. Tying a task to a company hides it from teammates not on it.
 */
export function CompanyPicker({
  id,
  "aria-label": ariaLabel,
  companies,
  value,
  onChange,
  className,
}: {
  id?: string;
  "aria-label"?: string;
  companies: readonly CompanyId[];
  value: CompanyId | null;
  onChange: (company: CompanyId | null) => void;
  className?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(event) =>
        onChange(event.target.value === "" ? null : (event.target.value as CompanyId))
      }
      className={cn(fieldClass, className)}
    >
      <option value="">Both companies</option>
      {companies.map((company) => (
        <option key={company} value={company}>
          {COMPANIES[company].name}
        </option>
      ))}
    </select>
  );
}
