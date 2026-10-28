"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { BACKFILL_MONTHS } from "@convex/lib/limits";
import { quietButtonClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "started" }
  | { kind: "error"; message: string };

/**
 * Start a pulled source's sync by hand. The sync runs in the background; its
 * outcome arrives through the source's status above these buttons.
 */
export function RunSource({
  source,
  label,
  backfill = true,
  className = "mt-3",
}: {
  source: string;
  label: string;
  /** False when every run already reads all the source keeps. */
  backfill?: boolean;
  /** Where it sits: under a card's text by default, or in a table's last cell. */
  className?: string;
}) {
  const runNow = useMutation(api.sources.runNow);
  const [state, setState] = useState<State>({ kind: "idle" });
  const starting = state.kind === "starting";

  const start = async (backfill: boolean) => {
    if (starting) return;
    setState({ kind: "starting" });
    try {
      await runNow(backfill ? { source, backfill: true } : { source });
      setState({ kind: "started" });
    } catch (error) {
      setState({ kind: "error", message: messageOf(error, "The sync could not be started.") });
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {/* aria-disabled, not disabled: a natively disabled button loses focus.
          The name begins with the visible text (WCAG 2.5.3), then says whose. */}
      <button
        type="button"
        aria-label={`Run now: ${label}`}
        aria-disabled={starting}
        onClick={() => start(false)}
        className={cn(quietButtonClass, "h-8 bg-surface px-3 text-xs text-ink whitespace-nowrap aria-disabled:opacity-60")}
      >
        Run now
      </button>
      {backfill && (
        <button
          type="button"
          aria-label={`Backfill ${BACKFILL_MONTHS} months: ${label}`}
          aria-disabled={starting}
          onClick={() => start(true)}
          className={cn(quietButtonClass, "h-8 px-3 text-xs whitespace-nowrap aria-disabled:opacity-60")}
        >
          Backfill {BACKFILL_MONTHS} months
        </button>
      )}
      {state.kind === "error" ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {state.message}
        </p>
      ) : (
        <p role="status" className="basis-full text-xs text-ink-2">
          {state.kind === "started" && "Started. It is listed under Recent runs when it finishes; a backfill can take a minute."}
        </p>
      )}
    </div>
  );
}
