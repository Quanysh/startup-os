import type { FunnelRow } from "@/lib/pipeline/funnel";
import { cn } from "@/lib/utils";

/**
 * A board's stages as a small table with a bar per stage. Every figure is
 * written out beside its bar, so the bars are decoration for the eye and the
 * table is the whole of it for a screen reader: no tooltip is needed.
 *
 * One series, so one colour and no legend. Bars start at the left edge and
 * are measured against the fullest stage. An empty stage draws no bar: zero
 * is a real zero here, the board having been read.
 *
 * `amount` adds a sum per stage. A stage whose cards have no amount reads
 * "No amount", never a zero; an empty stage has nothing to sum and says nothing.
 *
 * A summary of a page that has the full table: so no download here. With
 * `amount` and no stage having one, the column is left out and one line
 * says so ("No amount" in every row read as noise).
 */
export function Funnel({
  caption,
  countHeading,
  rows,
  amount,
  total,
}: {
  caption: string;
  /** What is counted: "Deals", "Investors". */
  countHeading: string;
  rows: readonly FunnelRow[];
  amount?: {
    heading: string;
    format: (value: number) => string;
    /** Said once under the table when no stage has an amount. */
    missing: string;
  };
  /** A last row for the whole board: its count and, with `amount`, its sum as it reads. */
  total?: { label: string; count: number; value: string };
}) {
  const fullest = Math.max(0, ...rows.map((row) => row.count));
  // No stage has an amount: the column would say "No amount" in every row.
  const amounts = amount !== undefined && rows.some((row) => row.value !== null) ? amount : undefined;
  const number = "py-1.5 pl-3 text-right font-num text-ink whitespace-nowrap";
  return (
    <div>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-[11px] text-ink-3">
            <th scope="col" className="pb-1 text-left font-normal">
              Stage
            </th>
            {/* The bars' column: drawn for the eye, so not in the download. */}
            <td data-export-skip="" />
            <th scope="col" className="pb-1 pl-3 text-right font-normal">
              {countHeading}
            </th>
            {amounts && (
              <th scope="col" className="pb-1 pl-3 text-right font-normal">
                {amounts.heading}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="py-1.5 pr-3 text-left font-normal whitespace-nowrap text-ink-2">
                {row.title}
              </th>
              <td className="w-full py-1.5">
                {row.count > 0 && (
                  <span
                    aria-hidden
                    className="block h-2 min-w-[3px] rounded-r-[2px] forced-color-adjust-none"
                    style={{
                      width: `${(row.count / fullest) * 100}%`,
                      backgroundColor: "var(--chart-1)",
                    }}
                  />
                )}
              </td>
              <td className={number}>{row.count}</td>
              {amounts && (
                <td className={cn(number, row.value === null && "font-sans text-ink-3")}>
                  {row.value !== null ? amounts.format(row.value) : row.count > 0 ? "No amount" : ""}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t border-line">
              <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                {total.label}
              </th>
              <td />
              <td className={cn(number, "py-2 font-medium")}>{total.count}</td>
              {amounts && <td className={cn(number, "py-2 font-medium")}>{total.value}</td>}
            </tr>
          </tfoot>
        )}
      </table>
      {amount !== undefined && amounts === undefined && (
        <p className="mt-2 text-xs text-ink-2">{amount.missing}</p>
      )}
    </div>
  );
}
