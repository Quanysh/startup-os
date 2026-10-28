"use client";

import { useRef, type Ref } from "react";
import { variantNames, type Issue, type Variants } from "@convex/lib/agentHarness";
import type { GateState } from "@convex/lib/agentJobs";
import { fieldClass } from "@/components/panel";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import {
  GATE_SHORT,
  changes,
  lineDiff,
  placeWords,
  templateSegments,
  versionStatusWords,
  type VersionStatus,
} from "@/lib/agents/harness";
import { cn } from "@/lib/utils";

// Pieces the Harness, Tests and Versions tabs share: a line diff, the
// problems a draft has, a template field that marks its sections, the
// variant switcher, and the chips for a version's state and its tests.

/** Two texts' lines side by side in one column: removed struck through, added marked, both in words. */
export function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const diff = lineDiff(before, after);
  if (!changes(diff)) return <p className="text-xs text-ink-3">{`${label}: no change.`}</p>;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 text-xs font-medium text-ink-2">{label}</figcaption>
      <pre
        aria-label={`${label}, changes`}
        className="max-h-80 overflow-auto rounded-inner bg-surface p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink"
      >
        {diff.map((line, i) => (
          <span
            key={i}
            className={cn(
              "block px-1",
              line.kind === "added" && "bg-success-soft text-success-ink",
              line.kind === "removed" && "bg-danger-soft text-danger-ink line-through",
            )}
          >
            <span className="sr-only">{line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}</span>
            <span aria-hidden>{line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}</span>
            {line.text === "" ? " " : line.text}
          </span>
        ))}
      </pre>
    </figure>
  );
}

/** What breaks a rule, by part: the path, then the words. */
export function ProblemList({ issues, empty }: { issues: readonly Issue[]; empty?: string }) {
  if (issues.length === 0) {
    return empty === undefined ? null : <p className="text-sm text-success-ink">{empty}</p>;
  }
  return (
    <ul role="alert" className="space-y-1 rounded-inner bg-danger-soft px-3 py-2 text-sm text-danger-ink">
      {issues.map((issue, i) => (
        <li key={i} className="break-words">
          <code className="font-mono text-xs">{issue.path}</code>
          {issue.at !== undefined && <span className="text-xs">{`, ${placeWords(issue)}`}</span>} {issue.message}
        </li>
      ))}
    </ul>
  );
}

const GATE_TONE: Record<GateState, StatusTone> = {
  passed: "success",
  no_run: "neutral",
  running: "info",
  stale: "warning",
  failed: "danger",
};

export function GateChip({ gate }: { gate: GateState }) {
  return <StatusChip tone={GATE_TONE[gate]}>{GATE_SHORT[gate]}</StatusChip>;
}

const VERSION_TONE: Record<VersionStatus, StatusTone> = { draft: "info", published: "success", archived: "neutral" };

export function VersionChip({ status, wasPublished }: { status: VersionStatus; wasPublished: boolean }) {
  return <StatusChip tone={VERSION_TONE[status]}>{versionStatusWords(status, wasPublished)}</StatusChip>;
}

/** JSON (a model's answer to made-up data, a schema), folded away until asked for. */
export function JsonFold({ summary, json }: { summary: string; json: string | null }) {
  if (json === null) return <span className="text-xs text-ink-3">None</span>;
  let text = json;
  try {
    text = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // Shown as it came.
  }
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">{summary}</summary>
      <pre className="mt-1 max-h-64 max-w-[36rem] overflow-auto rounded-inner bg-surface p-2 font-mono text-xs whitespace-pre-wrap text-ink">
        {text}
      </pre>
    </details>
  );
}

/** What a marked section means, said once under the template fields. */
export const SECTION_NOTE =
  "Marked: a section. {{#name}}…{{/name}} is kept only when name has a value; {{^name}}…{{/name}} only when it has none. Sections do not nest.";

/**
 * A template's text field, its sections marked behind the text: a backdrop
 * with the same text, invisible, and each section's ground tinted. The text
 * itself is the field's, so typing, selection and the caret are the browser's.
 */
export function TemplateField({
  id,
  label,
  value,
  rows = 8,
  invalid,
  fieldRef,
  onChange,
  onFocus,
}: {
  id: string;
  label: string;
  value: string;
  rows?: number;
  invalid?: boolean;
  fieldRef?: Ref<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onFocus?: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const text = "font-mono text-xs leading-5 whitespace-pre-wrap break-words";
  return (
    <div className="min-w-0">
      <label className="block text-sm text-ink" htmlFor={id}>
        {label}
      </label>
      <div className="relative mt-1 rounded-inner bg-panel">
        <div
          ref={backdrop}
          aria-hidden
          className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-inner border border-transparent px-3 py-2 text-transparent", text)}
        >
          {templateSegments(value).map((piece, i) =>
            piece.section === null ? (
              <span key={i}>{piece.text}</span>
            ) : (
              <mark
                key={i}
                className={cn("rounded-sm text-transparent", piece.section.inverted ? "bg-kind-sand-soft" : "bg-kind-violet-soft")}
              >
                {piece.text}
              </mark>
            ),
          )}
          {"\n"}
        </div>
        <textarea
          id={id}
          ref={fieldRef}
          rows={rows}
          value={value}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          onFocus={onFocus}
          onScroll={(event) => {
            if (backdrop.current !== null) backdrop.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onChange={(event) => onChange(event.target.value)}
          className={cn(fieldClass, "relative bg-transparent py-2", text)}
        />
      </div>
    </div>
  );
}

/** One button a variant, the one in view pressed; each says how many problems it has. */
export function VariantSwitcher({
  names,
  current,
  problems,
  notDeclared = [],
  onPick,
}: {
  names: readonly string[];
  current: string;
  problems: ReadonlyMap<string, number>;
  notDeclared?: readonly string[];
  onPick: (name: string) => void;
}) {
  return (
    <div role="group" aria-label="Variants" className="flex flex-wrap gap-1 rounded-inner bg-surface p-1">
      {names.map((name) => {
        const count = problems.get(name) ?? 0;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={name === current}
            onClick={() => onPick(name)}
            className={cn(
              "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-2.5 font-mono text-xs text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
              name === current && "bg-panel font-medium text-ink shadow-soft-sm",
            )}
          >
            <span className="truncate">{name}</span>
            {notDeclared.includes(name) && <span className="font-sans text-ink-3">not declared</span>}
            {count > 0 && (
              <span className="rounded-full bg-danger-soft px-1.5 font-sans text-[10px] text-danger-ink">
                {`${count} problem${count === 1 ? "" : "s"}`}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Each variant's templates against another's, only where they differ. */
export function VariantDiffs({ before, after }: { before: Variants; after: Variants }) {
  const names = variantNames({ ...before, ...after });
  const changed = names.filter(
    (name) =>
      (before[name]?.system ?? "") !== (after[name]?.system ?? "") || (before[name]?.user ?? "") !== (after[name]?.user ?? ""),
  );
  if (changed.length === 0) return <p className="mt-2 text-xs text-ink-3">No variant changes.</p>;
  return (
    <div className="mt-2 space-y-4">
      {changed.map((name) => (
        <div key={name} className="space-y-2">
          <p className="text-xs font-medium text-ink">
            {before[name] === undefined ? `${name}, added` : after[name] === undefined ? `${name}, dropped` : name}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            <DiffView label={`${name}, system`} before={before[name]?.system ?? ""} after={after[name]?.system ?? ""} />
            {(before[name]?.user !== undefined || after[name]?.user !== undefined) && (
              <DiffView label={`${name}, user`} before={before[name]?.user ?? ""} after={after[name]?.user ?? ""} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
