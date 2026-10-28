"use client";

import { ListTodoIcon } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { MAX_NEXT_STEP_LENGTH } from "@convex/lib/limits";
import { BulkArchive, BulkBar, bulkControlClass, bulkQuietClass } from "@/components/pipeline/bulk-bar";
import { messageOf } from "@/lib/errors";
import type { InvestorCard } from "@/lib/fundraising/sync";
import { bulkRefusalWords } from "@/lib/fundraising/words";
import { INVESTOR_COLUMNS, stageTitle } from "@/lib/pipeline/stages";
import { cn } from "@/lib/utils";

/** What `investors.bulk` does to every investor it is given. */
export type InvestorBulkAction =
  | { kind: "move"; stage: string }
  | { kind: "archive" }
  | { kind: "nextStep"; text: string };

/** How it went for one of them: the server's own words (`error`), or a `code` for a refusal said here. */
export type InvestorBulkResult = { id: string; ok: boolean; code?: string; error?: string };

/**
 * What to do with the investors ticked in the table: give them a stage, a
 * next step, or archive them (asked first; they can be restored). One call
 * to `investors.bulk`, which answers for each investor; the bar says how
 * many it did and, for each it refused, the investor and why. The refused
 * stay selected; the rest are let go.
 */
export function InvestorBulkBar({
  selected,
  onBulk,
  onKeep,
  onClear,
}: {
  /** The investors ticked, as they are on screen. */
  selected: readonly InvestorCard[];
  onBulk: (ids: string[], action: InvestorBulkAction) => Promise<readonly InvestorBulkResult[]>;
  onKeep: (ids: readonly string[]) => void;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReactNode>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const fieldId = useId();
  const count = selected.length;

  const run = async (
    investors: readonly InvestorCard[],
    action: InvestorBulkAction,
    done: (n: number) => string,
  ) => {
    if (busy || investors.length === 0) return;
    setBusy(true);
    try {
      const results = await onBulk(
        investors.map((investor) => investor.id),
        action,
      );
      const nameOf = new Map(investors.map((investor) => [investor.id, investor.name]));
      const refused = results.filter((result) => !result.ok);
      const accepted = results.length - refused.length;
      const summary =
        refused.length === 0
          ? done(accepted)
          : accepted === 0
            ? `${refused.length} refused`
            : `${done(accepted)}, ${refused.length} refused`;
      setReport(
        <>
          <p>{summary}</p>
          {refused.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {refused.map((result) => (
                <li key={result.id}>{`${nameOf.get(result.id) ?? "An investor"}: ${result.error ?? bulkRefusalWords(result.code)}`}</li>
              ))}
            </ul>
          )}
        </>,
      );
      if (refused.length === 0) onClear();
      else onKeep(refused.map((result) => result.id));
      setWriting(false);
      setText("");
    } catch (failure) {
      setReport(messageOf(failure, "That change could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const moveTo = (stage: string) => {
    const title = stageTitle(INVESTOR_COLUMNS, stage);
    const investors = selected.filter((investor) => investor.stage !== stage);
    if (investors.length === 0) return setReport(`Already in ${title}.`);
    void run(investors, { kind: "move", stage }, (n) => `${n} moved to ${title}`);
  };
  const setNextStep = (event: FormEvent) => {
    event.preventDefault();
    const typed = text.trim();
    if (typed === "") return setReport("Type the next step first.");
    void run(selected, { kind: "nextStep", text: typed }, (n) => `Next step set on ${n}`);
  };

  return (
    <BulkBar
      label="Selected investors"
      reportLabel="Bulk results"
      count={count}
      busy={busy}
      onClear={() => {
        setWriting(false);
        onClear();
      }}
      report={report}
    >
      <select
        aria-label="Set stage"
        aria-disabled={busy}
        value=""
        onChange={(event) => event.target.value && moveTo(event.target.value)}
        className={bulkControlClass}
      >
        <option value="">Set stage…</option>
        {INVESTOR_COLUMNS.map((column) => (
          <option key={column.id} value={column.id}>
            {column.title}
          </option>
        ))}
      </select>
      {writing ? (
        <form onSubmit={setNextStep} className="flex min-w-0 items-center gap-1">
          <label htmlFor={fieldId} className="sr-only">
            Next step for the selected
          </label>
          <input
            id={fieldId}
            value={text}
            autoFocus
            maxLength={MAX_NEXT_STEP_LENGTH}
            onChange={(event) => setText(event.target.value)}
            placeholder="Next step"
            className={cn(bulkControlClass, "w-44 min-w-0")}
          />
          <button type="submit" aria-disabled={busy} className={cn(bulkQuietClass, "text-ink")}>
            Set
          </button>
        </form>
      ) : (
        <button type="button" aria-disabled={busy} onClick={() => setWriting(true)} className={bulkQuietClass}>
          <ListTodoIcon aria-hidden className="size-3.5" />
          Set next step
        </button>
      )}
      <BulkArchive
        count={count}
        one="investor"
        many="investors"
        busy={busy}
        onArchive={() =>
          void run(selected, { kind: "archive" }, (n) =>
            `${n} archived: ${n === 1 ? "it is" : "they are"} under Archived investors, where ${n === 1 ? "it" : "they"} can be restored`,
          )
        }
      />
    </BulkBar>
  );
}
