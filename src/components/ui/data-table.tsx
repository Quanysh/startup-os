import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TableDownload } from "./table-download";

/**
 * The one table every list of records wears: a tinted header band naming
 * each field, one record per row on a hairline, every second record on a
 * stripe, numbers right-aligned in tabular figures, actions last, totals on a
 * band of their own. Presentational only: no sorting, no state, no data.
 *
 * Every table can be downloaded: a quiet "CSV" under it, at its right, saves
 * what the viewer is shown (`src/lib/table-export.ts` reads the rendered
 * rows, so a download never holds more than the screen). `download` names
 * the file (by default the caption or label, and today's date) or, `false`,
 * turns it off where a file makes no sense. The actions column is left out;
 * `noExport` leaves out another column (on its header) or a row, and
 * `exportValue` writes a cell's value in place of what it shows.
 *
 * Colour is here to find one's place, and it is all in this file and in
 * `src/styles/globals.css` (the rules keyed on `data-slot="data-table"`):
 * the stripe and the row in hand (hover or focus inside it), a `tone` for a
 * row that needs attention, a `group` for columns that belong together, and
 * `strong` for the column people look for. What a cell says about a state or
 * a kind is a `StatusChip` or a `KindTag` (`./status-chip`).
 *
 * A table wider than its panel scrolls sideways inside its own box (the page
 * never does), and a `pinned` first column stays in view while it scrolls on
 * a phone. A column marked `hideBelow` drops out under that breakpoint; the
 * caller keeps the same fact reachable some other way.
 */

type Breakpoint = "sm" | "md" | "lg";

const HIDE: Record<Breakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

// The cell inset. The scroll box bleeds by the same amount, so the first
// column's text sits flush with the panel's heading and a row's hover tint
// reaches a little past its text on both sides.
const PAD = "px-3";

// Pinned while the table scrolls sideways on a phone. It needs a ground of
// its own or the columns would show through it: its row's (`--row-bg`, which
// is the stripe, the hover, an attention tint or the header band), else the
// table's (`--table-bg`).
const PINNED =
  "max-sm:sticky max-sm:left-0 max-sm:z-[1] max-sm:max-w-[11rem] max-sm:bg-[var(--row-bg,var(--table-bg,var(--color-panel)))] max-sm:shadow-[1px_0_0_var(--color-line)]";

/** Columns that belong together wear one hue (a `KindTag` hue, never a status colour). */
export type ColumnGroup = "teal" | "violet";

/** A row that needs attention, in the two tones that ask for it. */
export type RowTone = "danger" | "warning";

type Naming =
  | {
      /** What the table holds. Read by a screen reader; shown only with `showCaption`. */
      caption: ReactNode;
      showCaption?: boolean;
      label?: undefined;
    }
  | {
      /** The table's accessible name, when a caption element is not wanted. */
      label: string;
      caption?: undefined;
      showCaption?: undefined;
    };

/** The table's name in words, for its download: the given name, the label, or a caption that is text. */
function nameOf(download: string | undefined, label: string | undefined, caption: ReactNode): string {
  if (download !== undefined) return download;
  if (label !== undefined) return label;
  return typeof caption === "string" || typeof caption === "number" ? String(caption) : "table";
}

export function DataTable({
  caption,
  showCaption = false,
  label,
  on = "panel",
  bleed = true,
  download,
  className,
  boxClassName,
  children,
  ...props
}: Omit<ComponentProps<"table">, "aria-label"> &
  Naming & {
    /** The ground the table sits on, so a pinned column can match it. */
    on?: "panel" | "surface";
    /** Reach past the container's text edge by the cell inset. Off where there is no padding to reach into. */
    bleed?: boolean;
    /**
     * The download under the table. A name for the file and the button
     * ("All costs"), else the caption or label is used; `false` where a file
     * makes no sense (a table of form fields, a table only a screen reader is
     * given).
     */
    download?: string | false;
    /** For the whole, the table and its download (margins). `className` goes on the table (a `min-w-*`). */
    boxClassName?: string;
  }) {
  return (
    // `min-w-0`: in a flex or grid parent the whole may shrink, so a wide table
    // scrolls inside its box rather than widening the page (the box alone did
    // that before the download sat beside it).
    <div data-slot="data-table-wrap" className={cn("min-w-0", boxClassName)}>
      <div
        data-slot="data-table-box"
        className={cn(
          // Rounded, so the header band and the totals band end in the panel's
          // own soft corners rather than square ones. `relative`: an sr-only
          // header label is absolutely positioned, and without a positioned box
          // it escaped the sideways scroll and widened the page on a phone.
          "relative overflow-x-auto rounded-inner",
          bleed && "-mx-3",
          // On the grey surface the stripe is the white of a panel.
          on === "surface" &&
            "[--table-bg:var(--color-surface)] [--table-stripe:var(--color-panel)]",
        )}
      >
        <table
          data-slot="data-table"
          aria-label={label}
          className={cn("w-full border-collapse text-left text-sm text-ink", className)}
          {...props}
        >
          {caption !== undefined && (
            <caption
              className={showCaption ? cn(PAD, "pb-2 text-left text-xs text-ink-3") : "sr-only"}
            >
              {caption}
            </caption>
          )}
          {children}
        </table>
      </div>
      {download !== false && (
        <TableDownload name={nameOf(download, label, caption)} on={on} bleed={bleed} />
      )}
    </div>
  );
}

/** What the reader in `src/lib/table-export.ts` is told about a row or a cell. */
type ExportOptions = {
  /** Left out of the download: a row, or (on its header) a whole column. */
  noExport?: boolean;
  /** Written in the download in place of what the cell shows. */
  exportValue?: string;
};

const exportMarks = ({ noExport, exportValue }: ExportOptions) => ({
  "data-export-skip": noExport ? "" : undefined,
  "data-export": exportValue,
});

/** The header row. Its children are `DataHeader` cells. */
export function DataHead({ className, children, ...props }: ComponentProps<"thead">) {
  return (
    <thead data-slot="data-head" className={className} {...props}>
      <tr>{children}</tr>
    </thead>
  );
}

export function DataBody({
  stripe = "rows",
  className,
  ...props
}: ComponentProps<"tbody"> & {
  /**
   * What the zebra counts. `rows`: every second record of this body. `groups`:
   * every second body, for a table that gives each record a body of its own
   * (its row and whatever is opened under it). `none`: no stripe.
   */
  stripe?: "rows" | "groups" | "none";
}) {
  return (
    <tbody
      data-slot="data-body"
      data-stripe={stripe}
      className={cn("[&>tr:last-child]:border-b-0", className)}
      {...props}
    />
  );
}

/** Totals. Set apart from the records: a firmer line above, the header's band, heavier figures. */
export function DataFoot({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="data-foot"
      className={cn("font-medium [&>tr:last-child]:border-b-0", className)}
      {...props}
    />
  );
}

export function DataRow({
  plain = false,
  tone,
  noExport,
  className,
  ...props
}: ComponentProps<"tr"> &
  Pick<ExportOptions, "noExport"> & {
  /**
   * Not a record: a totals row, or a row that holds an editor or a breakdown.
   * It is not counted by the stripe and is not lit under the pointer.
   */
  plain?: boolean;
  /**
   * A record that needs attention (overdue, at risk, failed; incomplete): a
   * faint ground and a bar down its left edge. The cell that says why (a
   * chip, a line of words) is the caller's: the tone is never the only sign.
   */
  tone?: RowTone;
}) {
  return (
    <tr
      data-row={plain ? "plain" : "record"}
      data-tone={tone}
      {...exportMarks({ noExport })}
      className={cn("border-b border-line align-top", !plain && "transition-colors", className)}
      {...props}
    />
  );
}

type CellOptions = {
  /** A number: right-aligned, tabular figures, never wrapped. */
  numeric?: boolean;
  /**
   * A column of a word or a control (a switch, a chip, "Yes"): no floor
   * width. Every other column of words has one (`TEXT_FLOOR`).
   */
  narrow?: boolean;
  /** Stays in view while the table scrolls sideways on a phone. First column only. */
  pinned?: boolean;
  /** Dropped under this breakpoint. Give the header and its cells the same one. */
  hideBelow?: Breakpoint;
  /** The group of columns this one belongs to. Give the header and its cells the same one. */
  group?: ColumnGroup;
  /** The column people look for: heavier, and its group's tint a shade deeper. */
  strong?: boolean;
};

// A column of words keeps this much room: a crowded table scrolls sideways
// in its box rather than crushing a note or a name to a word a line.
const TEXT_FLOOR = "min-w-[9rem]";
const NAME_FLOOR = "min-w-[10rem]";

const cellOptions = ({ numeric, narrow, pinned, hideBelow }: CellOptions) =>
  cn(
    numeric && "text-right whitespace-nowrap",
    !numeric && !narrow && TEXT_FLOOR,
    pinned && PINNED,
    hideBelow !== undefined && HIDE[hideBelow],
  );

/** The attributes the stylesheet reads for a column's group and its emphasis. */
const columnMarks = ({ group, strong }: CellOptions) => ({
  "data-group": group,
  "data-strong": strong ? "" : undefined,
});

/** A column's name. */
export function DataHeader({
  numeric,
  narrow,
  pinned,
  hideBelow,
  group,
  strong,
  noExport,
  exportValue,
  className,
  ...props
}: Omit<ComponentProps<"th">, "scope"> & CellOptions & ExportOptions) {
  return (
    <th
      scope="col"
      {...columnMarks({ group, strong })}
      {...exportMarks({ noExport, exportValue })}
      className={cn(
        PAD,
        "py-2.5 align-bottom text-xs whitespace-nowrap",
        strong ? "font-semibold text-ink" : "font-medium text-table-head-ink",
        cellOptions({ numeric, narrow, pinned, hideBelow }),
        className,
      )}
      {...props}
    />
  );
}

/** The last column's header: named for a screen reader, blank to the eye, and not downloaded. */
export function ActionsHeader({ children = "Actions" }: { children?: ReactNode }) {
  return (
    <th scope="col" data-export-skip="" className={cn(PAD, "py-2.5")}>
      <span className="sr-only">{children}</span>
    </th>
  );
}

/**
 * A row's first cell: the record itself (its name, or the button that opens
 * it), in ink at medium weight so every row has a clear start. A second line
 * under the name is the caller's, and is quieter (`text-xs text-ink-2`).
 */
export function DataRowHeader({
  pinned,
  hideBelow,
  exportValue,
  className,
  ...props
}: Omit<ComponentProps<"th">, "scope"> &
  Omit<CellOptions, "numeric"> &
  Pick<ExportOptions, "exportValue">) {
  return (
    <th
      scope="row"
      {...exportMarks({ exportValue })}
      className={cn(
        PAD,
        "py-3 text-left font-medium text-ink",
        NAME_FLOOR,
        cellOptions({ narrow: true, pinned, hideBelow }),
        className,
      )}
      {...props}
    />
  );
}

export function DataCell({
  numeric,
  narrow,
  pinned,
  hideBelow,
  group,
  strong,
  actions = false,
  noExport,
  exportValue,
  className,
  ...props
}: ComponentProps<"td"> &
  CellOptions &
  ExportOptions & {
    /** The row's buttons: last column, right-aligned, kept on one line. Not downloaded. */
    actions?: boolean;
  }) {
  return (
    <td
      {...columnMarks({ group, strong })}
      {...exportMarks({ noExport: noExport || actions, exportValue })}
      className={cn(
        PAD,
        actions ? "py-1.5 text-right whitespace-nowrap" : "py-3",
        numeric && "font-num text-ink",
        strong && "font-semibold text-ink",
        cellOptions({ numeric, narrow: narrow || actions, pinned, hideBelow }),
        className,
      )}
      {...props}
    />
  );
}

/** A row's button: smaller than a form's, so a row stays one line tall. */
export const rowActionClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-ink-2 outline-none transition hover:bg-panel hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 aria-disabled:opacity-60";

/** The same, for a button that is an icon alone (it needs an `aria-label`). */
export const rowIconActionClass = cn(rowActionClass, "w-9 px-0");

/**
 * A value that is not there: said, not left as a blank cell. In the secondary
 * ink, which keeps 4.5:1 on the stripe and the hover ground.
 */
export function Blank({ children = "—" }: { children?: ReactNode }) {
  return <span className="text-ink-2">{children}</span>;
}
