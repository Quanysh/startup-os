import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { pileUp, stuckOnes, type Item } from "@/lib/engineering/view";
import { OwnerChip, TitleLink } from "./pull-bits";

/**
 * What is stuck, and where work is piling up, in words: how many pull
 * requests are stuck with the three stuck the longest named, then which open
 * stage holds the most against last week's merged count.
 *
 * State table for the first line (first matching row wins):
 *   none stuck   → "No pull request is stuck."
 *   one          → "1 pull request is stuck."
 *   more         → "N pull requests are stuck."
 * The second line is `pileUp`'s, and is absent where last week's merged
 * count is not known: nothing is made up to fill it.
 */
export function StuckStrip({
  items,
  mergedLastWeek,
}: {
  items: readonly Item[];
  /** Last finished week's merged count for the companies in view; null where it is not known. */
  mergedLastWeek: number | null;
}) {
  const { count, oldest } = stuckOnes(items);
  const pile = pileUp(items, mergedLastWeek);
  return (
    <div className="space-y-3 text-sm text-ink-2">
      <p className="flex items-center gap-2 text-base font-medium text-ink">
        {count === 0 ? (
          <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-success-ink" />
        ) : (
          <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-danger-ink" />
        )}
        <span>
          {count === 0
            ? "No pull request is stuck."
            : `${count} pull ${count === 1 ? "request is" : "requests are"} stuck.`}
        </span>
      </p>
      {oldest.length > 0 && (
        <ul aria-label="Stuck the longest" className="space-y-2">
          {oldest.map((item) => (
            <li
              key={`${item.pull.repoId}#${item.pull.number}`}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
            >
              <TitleLink pull={item.pull} className="min-w-0 font-medium break-words text-ink" />
              <OwnerChip owner={item.owner} className="text-ink" />
              <span>{item.placed.stuck.map((why) => why.words).join("; ")}</span>
            </li>
          ))}
        </ul>
      )}
      {pile !== null && <p>{pile}</p>}
    </div>
  );
}
