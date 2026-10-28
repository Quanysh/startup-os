"use client";

import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import { PR_CLOSED_SHOWN_DAYS } from "@convex/lib/limits";
import { StatusChip } from "@/components/ui/status-chip";
import { BAND_HEIGHT, flowBand } from "@/lib/engineering/band";
import { STAGE_LABELS, ageWords, sinceWords, type Stage } from "@/lib/engineering/flow";
import { repoName, type Column, type Item } from "@/lib/engineering/view";
import { cn } from "@/lib/utils";
import { ChecksChip, OwnerChip, TitleLink, reviewersLine } from "./pull-bits";

/** Cards shown in a stage before "Show all". */
export const FLOW_SHOWN = 6;

/**
 * The pull-request process as a flow: the stages left to right, one band
 * running through them that is as thick at each stage as the stage is full,
 * and under each head the pull requests that sit there.
 *
 * The band is one path, seen through one window per stage, so it stays under
 * its stage's head when the heads stick. It is drawn for the eye only: every
 * count it shows is written above it, and a reader is not read a shape. One
 * hue and one scale for all five stages; the merged stage is the last 14
 * days and says so.
 *
 * Read-only: nothing is dragged, and nothing here writes to GitHub.
 *
 * On a phone the flow scrolls sideways inside its own box (the page never
 * does), in a box of limited height so the stage heads can stay in view
 * while the cards scroll under them.
 */
export function FlowPanel({ columns, closed }: { columns: readonly Column[]; closed: number }) {
  const [expanded, setExpanded] = useState<ReadonlySet<Stage>>(new Set());
  const band = flowBand(columns.map((column) => column.items.length));
  return (
    <>
      <div
        data-slot="flow-scroll"
        className="-mx-5 overflow-x-auto px-5 max-sm:max-h-[78vh] max-sm:overflow-y-auto sm:-mx-6 sm:px-6"
      >
        {/* No gap between the columns: the band runs from one into the next. */}
        <div className="grid min-w-[62rem] grid-cols-5">
          {columns.map((column, index) => {
            const label = STAGE_LABELS[column.stage];
            const total = column.items.length;
            const open = expanded.has(column.stage);
            const shown = open ? column.items : column.items.slice(0, FLOW_SHOWN);
            return (
              <div key={column.stage} role="group" aria-label={label} className="flex min-w-0 flex-col">
                <div data-testid="flow-head" className="sticky top-0 z-10 bg-panel pb-3">
                  <div className="flex items-center justify-between gap-1 px-2">
                    <h3 className="text-sm font-medium text-ink">{label}</h3>
                    {index < columns.length - 1 && (
                      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-ink-3" />
                    )}
                  </div>
                  <p className="mt-0.5 flex items-baseline gap-2 px-2">
                    <span data-slot="flow-count" className="text-3xl font-semibold tracking-tight text-ink">
                      {total}
                    </span>
                    {column.stage === "merged" && (
                      <span className="text-xs text-ink-2">{`last ${PR_CLOSED_SHOWN_DAYS} days`}</span>
                    )}
                  </p>
                  <svg
                    data-testid="flow-band"
                    data-thickness={band.thickness[index]}
                    aria-hidden="true"
                    focusable="false"
                    viewBox={`${index * 100} 0 100 ${BAND_HEIGHT}`}
                    preserveAspectRatio="none"
                    className="mt-2 block h-12 w-full"
                  >
                    <path d={band.path} fill="var(--chart-1)" />
                  </svg>
                  <div className="mt-2 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 px-2 text-xs text-ink-2">
                    {column.stuck > 0 && <StatusChip tone="danger">{`${column.stuck} stuck`}</StatusChip>}
                    {column.medianMs !== null && <span>{`Median ${ageWords(column.medianMs)}`}</span>}
                  </div>
                </div>

                {total === 0 ? (
                  // An empty stage: a quiet dash, not an empty box.
                  <p className="px-2 text-sm text-ink-3">
                    <span aria-hidden>—</span>
                    <span className="sr-only">None</span>
                  </p>
                ) : (
                  <ul className="space-y-2 px-1.5">
                    {shown.map((item) => (
                      <Card key={`${item.pull.repoId}#${item.pull.number}`} item={item} />
                    ))}
                  </ul>
                )}
                {total > FLOW_SHOWN && (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((before) => {
                        const next = new Set(before);
                        if (open) next.delete(column.stage);
                        else next.add(column.stage);
                        return next;
                      })
                    }
                    className="mx-1.5 mt-2 rounded-full px-2 py-1.5 text-left text-xs font-medium text-ink-2 outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {open ? `Show the first ${FLOW_SHOWN}` : `Show all ${total}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {closed > 0 && (
        <p className="mt-4 text-xs text-ink-2">
          {`${closed} closed without merging in the last ${PR_CLOSED_SHOWN_DAYS} days, listed in the table below.`}
        </p>
      )}
    </>
  );
}

/** One pull request in its stage. A stuck one is tinted, and says why in words. */
function Card({ item }: { item: Item }) {
  const { pull, placed, owner } = item;
  const stuck = placed.stuck.length > 0;
  const asked = reviewersLine(pull);
  return (
    <li
      data-stuck={stuck ? "true" : undefined}
      className={cn(
        "min-w-0 rounded-inner border p-3 text-xs text-ink-2",
        stuck ? "border-danger-mark/30 bg-row-danger" : "border-line bg-panel",
      )}
    >
      <p className="text-sm leading-snug font-medium break-words text-ink">
        <TitleLink pull={pull} />
      </p>
      <p className="mt-1 flex flex-wrap gap-x-1.5">
        <span className="break-all">{repoName(pull.repoId)}</span>
        <span className="font-num">{`#${pull.number}`}</span>
      </p>
      <p className="mt-2 text-ink">
        <OwnerChip owner={owner} />
      </p>
      <p className="mt-1.5">{`${ageWords(placed.ageMs)} ${sinceWords(placed.basis)}`}</p>
      {pull.state === "open" && (
        <p className="mt-1.5">
          <ChecksChip checks={pull.checks} />
        </p>
      )}
      {asked !== null ? (
        <p className="mt-1.5 break-words">{asked}</p>
      ) : (
        placed.stage === "waiting_for_review" && <p className="mt-1.5">Nobody is asked to review</p>
      )}
      {placed.stuck.map((why) => (
        <p key={why.reason} className="mt-1.5 flex items-start gap-1 font-medium text-danger-ink">
          <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{why.words}</span>
        </p>
      ))}
    </li>
  );
}
