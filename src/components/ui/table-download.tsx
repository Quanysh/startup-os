"use client";

import { DownloadIcon } from "lucide-react";
import { downloadTable } from "@/lib/table-export";
import { cn } from "@/lib/utils";

/**
 * "CSV" under a table, at its right: saves the table as the viewer sees it
 * (`src/lib/table-export.ts`), named after it and today's date. Quiet, so it
 * never competes with the table or the panel's own actions.
 *
 * It downloads the first table in the nearest `data-slot="data-table-wrap"`
 * around it: `DataTable` gives itself one; a hand-made table puts itself and
 * this in one. The row is marked `data-export-skip`, so a table opened inside
 * another's row is not read into the outer one's file.
 */
export function TableDownload({
  name,
  on = "panel",
  bleed = false,
  className,
}: {
  /** What the table holds, in its own words: "Download <name> as CSV". */
  name: string;
  /** The ground it sits on, so its hover tint shows. */
  on?: "panel" | "surface";
  /** The table reaches past the text edge: line the word up with its last column. */
  bleed?: boolean;
  className?: string;
}) {
  return (
    <div data-export-skip className={cn("mt-1 flex justify-end", bleed && "-mr-2.5", className)}>
      <button
        type="button"
        aria-label={`Download ${name} as CSV`}
        onClick={(event) => {
          const table = event.currentTarget.closest('[data-slot="data-table-wrap"]')?.querySelector("table");
          if (table) downloadTable(table, name);
        }}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
          on === "surface" ? "hover:bg-panel" : "hover:bg-surface",
        )}
      >
        <DownloadIcon aria-hidden className="size-3.5" />
        CSV
      </button>
    </div>
  );
}
