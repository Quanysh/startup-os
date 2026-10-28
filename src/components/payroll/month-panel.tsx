"use client";

import { useMutation } from "convex/react";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  RotateCcwIcon,
  UserPlusIcon,
} from "lucide-react";
import { Fragment, useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { api } from "@convex/_generated/api";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import type { Currency } from "@convex/lib/metricRegistry";
import {
  KIND_PLURALS,
  PAYROLL_KINDS,
  activeIn,
  draftRows,
  readRow,
  summarise,
  type CurrencySummary,
  type PayrollKind,
  type SummaryTotals,
  type Totals,
} from "@convex/lib/payroll";
import { nextPeriodStart, previousPeriodStart } from "@convex/lib/periods";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataFoot,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
  type ColumnGroup,
} from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { STATUS_INK, StatusChip } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import type { CompanyId } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { dayLabel, formatMinor, formatPeriod } from "@/lib/format";
import { formatRate, moneyInput, monthOf, parseMoney } from "@/lib/payroll/input";
import { cn } from "@/lib/utils";
import { CircleNote, FigureCell, MonthSummary } from "./month-summary";
import { OtherPeople, PersonEditor } from "./people";
import {
  ActionButton,
  CURRENCY_NAMES,
  Confirm,
  Failure,
  Money,
  PaidBy,
  PersonKind,
  RateNotSet,
  RunStatus,
  useAction,
  type Line,
  type Person,
  type Run,
  type RunRow,
} from "./shared";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why a row's figures are short, in the words the table shows; null when they are whole. */
function incompleteNote(row: RunRow): string | null {
  // Someone entered as net whose gross could not be worked out.
  if (row.gross === null) return `Incomplete: gross cannot be worked out ${missingGross(row, "until")}`;
  const parts = [
    row.rateNotSet > 0 ? `${plural(row.rateNotSet, "rate", "rates")} not set` : null,
    row.otherCurrency > 0
      ? `${plural(row.otherCurrency, "line", "lines")} not computed in this currency`
      : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `Incomplete: ${parts.join(", ")}`;
}

/**
 * Why a net-based row has no gross, to follow "gross cannot be worked out"
 * (`until`) or "gross not worked out … :" (`because`).
 */
function missingGross(row: RunRow, form: "until" | "because"): string {
  const withheld = row.lines.filter((line) => line.paidBy === "employee");
  if (row.grossMissing === "rate_not_set") {
    const n = withheld.filter((line) => line.skipped === "rate_not_set").length;
    return form === "until"
      ? `until ${plural(n, "rate is", "rates are")} set`
      : `${plural(n, "rate is", "rates are")} not set`;
  }
  if (row.grossMissing === "other_currency") {
    const n = withheld.filter((line) => line.skipped === "other_currency").length;
    return `${form === "until" ? "while" : ""} ${plural(n, "line withheld from pay is", "lines withheld from pay are")} not computed in this currency`.trim();
  }
  return form === "until"
    ? "with these rates: what is withheld leaves no gross that gives this net"
    : "with these rates, what is withheld leaves no gross that gives this net";
}

/** An amount, or a dash where there is none to show: never a zero in its place. */
function Amount({ minor, currency }: { minor: number | null; currency: Currency }) {
  return minor === null ? "—" : <Money minor={minor} currency={currency} />;
}

/**
 * The money columns, in two groups a glance can tell apart: teal is what a
 * person is paid (ending in net pay), violet what the company pays (ending in
 * total cost). Net pay and total cost are the two people look for.
 */
const COLUMNS: readonly { label: string; group: ColumnGroup; strong?: boolean }[] = [
  { label: "Gross", group: "teal" },
  { label: "Adjustment", group: "teal" },
  { label: "Withheld", group: "teal" },
  { label: "Net pay", group: "teal", strong: true },
  { label: "Company-paid", group: "violet" },
  { label: "Total cost", group: "violet", strong: true },
];
const ADJUSTMENT = 1;

// ── Adjustments ─────────────────────────────────────────────────────────────

/**
 * A one-off bonus or deduction, typed in the person's row and saved on Enter
 * or on leaving the field. What is typed is the field's own until it is
 * saved: a live update never replaces it.
 */
function AdjustmentCell({ company, month, row }: { company: CompanyId; month: string; row: RunRow }) {
  const setAdjustment = useMutation(api.payroll.setAdjustment);
  // null while nothing is typed: the field then shows what is saved.
  const [typed, setTyped] = useState<string | null>(null);
  const { error, setError, run } = useAction();
  const shown = typed ?? (row.adjustment === 0 ? "" : moneyInput(row.adjustment));

  const save = async () => {
    if (typed === null) return;
    const minor = typed.trim() === "" ? 0 : parseMoney(typed, { signed: true });
    if (minor === null) return setError("That is not an amount. Use a minus sign for a deduction.");
    if (minor === row.adjustment) return setTyped(null);
    const saved = await run(() =>
      setAdjustment({
        company,
        month,
        personId: row.personId,
        amount: minor,
        // The note stays with the amount it was written for.
        ...(minor !== 0 && row.adjustmentNote !== null ? { note: row.adjustmentNote } : null),
      }),
    );
    if (saved) setTyped(null);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        aria-label={`Adjustment for ${row.name}`}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={shown}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={() => void save()}
        className={cn(fieldClass, "h-8 w-28 px-2 text-right font-num")}
      />
      <Failure error={error} className="mt-1 max-w-40 whitespace-normal text-left font-sans text-xs" />
    </form>
  );
}

/** The note on a person's adjustment, in their breakdown. */
function NoteForm({ company, month, row }: { company: CompanyId; month: string; row: RunRow }) {
  const setAdjustment = useMutation(api.payroll.setAdjustment);
  // Read once, when the breakdown opens: a live update never replaces what is typed.
  const [note, setNote] = useState(row.adjustmentNote ?? "");
  const { busy, error, run } = useAction();
  const noteId = useId();
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void run(() =>
          setAdjustment({
            company,
            month,
            personId: row.personId,
            amount: row.adjustment,
            ...(note.trim() !== "" ? { note } : null),
          }),
        );
      }}
      className="mt-4 space-y-2"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-56 space-y-1.5">
          <Label htmlFor={noteId}>
            Note on the {row.adjustment > 0 ? "bonus" : "deduction"} of{" "}
            {formatMinor(row.adjustment, row.currency)}
          </Label>
          <input
            id={noteId}
            aria-label={`Adjustment note for ${row.name}`}
            autoComplete="off"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={`${fieldClass} h-10`}
          />
        </div>
        <ActionButton type="submit" busy={busy}>
          Save note
        </ActionButton>
      </div>
      <Failure error={error} />
    </form>
  );
}

// ── One person's breakdown ──────────────────────────────────────────────────

/** Each line of one person's month: what it was worked out on, at what rate, and what it came to. */
function Breakdown({
  company,
  month,
  row,
  live,
}: {
  company: CompanyId;
  month: string;
  row: RunRow;
  live: boolean;
}) {
  const companyCurrency = MARKET_CURRENCY[company];
  return (
    <div className="rounded-inner bg-surface p-4">
      {row.basis === "net" && row.targetNet !== null && (
        <p className="mb-3 text-sm text-ink">
          {row.gross === null
            ? `Gross not worked out from a net of ${formatMinor(row.targetNet, row.currency)}: ${missingGross(row, "because")}`
            : `Gross worked out from a net of ${formatMinor(row.targetNet, row.currency)}`}
        </p>
      )}
      {row.lines.length === 0 ? (
        <p className="text-sm text-ink-2">
          No tax or contribution line applies: net pay and total cost are the gross
          {row.adjustment !== 0 && " and the adjustment"}.
        </p>
      ) : (
        <DataTable caption={`Lines for ${row.name}`} on="surface" className="min-w-[32rem]">
          <DataHead>
            <DataHeader>Line</DataHeader>
            <DataHeader>Paid by</DataHeader>
            <DataHeader numeric>Base</DataHeader>
            <DataHeader numeric>Rate</DataHeader>
            <DataHeader numeric>Amount</DataHeader>
          </DataHead>
          <DataBody>
            {row.lines.map((line, index) => (
              <DataRow key={index} plain>
                <DataRowHeader>{line.name}</DataRowHeader>
                <DataCell>
                  <PaidBy payer={line.paidBy} />
                </DataCell>
                <DataCell numeric>
                  {line.base === null ? "—" : <Money minor={line.base} currency={row.currency} />}
                </DataCell>
                <DataCell numeric>
                  {line.rateBp === null ? <RateNotSet /> : formatRate(line.rateBp)}
                </DataCell>
                <DataCell
                  numeric
                  className={cn(
                    line.amount === null && "font-sans whitespace-normal",
                    line.amount === null && STATUS_INK.warning,
                  )}
                >
                  {line.amount !== null ? (
                    <Money minor={line.amount} currency={row.currency} />
                  ) : line.skipped === "other_currency" ? (
                    `Not computed: its allowance or cap is in ${CURRENCY_NAMES[companyCurrency]}`
                  ) : line.skipped === "gross_unknown" ? (
                    "Not computed: no gross"
                  ) : (
                    "Not computed"
                  )}
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}
      {live ? (
        row.adjustment !== 0 && <NoteForm company={company} month={month} row={row} />
      ) : (
        row.adjustment !== 0 && (
          <p className="mt-3 text-sm text-ink-2">
            Adjustment: <Money minor={row.adjustment} currency={row.currency} />
            {row.adjustmentNote !== null && ` (${row.adjustmentNote})`}
          </p>
        )
      )}
    </div>
  );
}

// ── The table ───────────────────────────────────────────────────────────────

/** A totals row in the foot: its label and its six cells, in the columns' order. */
type FootRow = { label: string; cells: readonly ReactNode[]; strong?: boolean };

/** Edit and Archive, for a person in a month that is not paid. */
function RowActions({ row, onEdit }: { row: RunRow; onEdit: () => void }) {
  const archive = useMutation(api.payroll.archivePerson);
  const { busy, error, run } = useAction();
  return (
    <>
      <button type="button" onClick={onEdit} className={rowActionClass}>
        <PencilIcon aria-hidden className="size-4" />
        Edit<span className="sr-only"> {row.name}</span>
      </button>
      <ActionButton
        busy={busy}
        icon={<ArchiveIcon aria-hidden className="size-4" />}
        className={rowActionClass}
        onClick={() =>
          void run(
            () => archive({ id: row.personId, archived: true }),
            "That person could not be archived. Try again.",
          )
        }
      >
        Archive<span className="sr-only"> {row.name}</span>
      </ActionButton>
      <Failure error={error} className="mt-1 whitespace-normal" />
    </>
  );
}

/**
 * The people paid in one currency, one row each, and that currency's totals.
 * Live, a row's adjustment is typed in place and each row has its actions;
 * paid, every cell is the frozen copy.
 */
function MonthTable({
  company,
  month,
  currency,
  rows,
  foot,
  live,
  onEdit,
}: {
  company: CompanyId;
  month: string;
  currency: Currency;
  rows: readonly RunRow[];
  foot: readonly FootRow[];
  live: boolean;
  onEdit: (id: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const span = COLUMNS.length + (live ? 2 : 1);

  return (
    // The table scrolls sideways inside its own box at phone width, with the
    // person pinned; the page does not scroll.
    <DataTable
      caption={`${formatPeriod("month", month)}, paid in ${currency}`}
      showCaption
      className={live ? "min-w-[56rem]" : "min-w-[46rem]"}
    >
      <DataHead>
        <DataHeader pinned>Person</DataHeader>
        {COLUMNS.map(({ label, group, strong }) => (
          <DataHeader key={label} numeric group={group} strong={strong}>
            {label}
          </DataHeader>
        ))}
        {live && <ActionsHeader />}
      </DataHead>
      <DataBody>
        {rows.map((row) => {
          const expanded = open.has(row.personId);
          const note = incompleteNote(row);
          // The money cells, in the columns' order. With no gross, nothing
          // withheld or company-paid is known: a dash, not a zero.
          const amounts = [
            row.gross,
            row.adjustment,
            row.gross === null ? null : row.withheld,
            row.net,
            row.gross === null ? null : row.companyPaid,
            row.cost,
          ];
          return (
            <Fragment key={row.personId}>
              <DataRow tone={note !== null ? "warning" : undefined}>
                <DataRowHeader pinned className="font-normal">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggle(row.personId)}
                    className="-ml-1 inline-flex items-center gap-1 rounded-inner px-1 text-left text-ink outline-none hover:bg-panel focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <ChevronDownIcon
                      aria-hidden
                      className={cn("size-4 shrink-0 text-ink-2 transition", !expanded && "-rotate-90")}
                    />
                    <span className="sr-only">Breakdown for </span>
                    <span className="font-medium">{row.name}</span>
                  </button>
                  <span className="mt-0.5 block pl-5 text-xs text-ink-2">
                    <PersonKind kind={row.kind} />
                    {row.title !== null && ` · ${row.title}`}
                  </span>
                  {note !== null && (
                    <span className={cn("mt-0.5 block pl-5 text-xs font-medium", STATUS_INK.warning)}>
                      {note}
                    </span>
                  )}
                </DataRowHeader>
                {amounts.map((minor, index) => (
                  <DataCell
                    key={index}
                    numeric
                    group={COLUMNS[index]!.group}
                    strong={COLUMNS[index]!.strong}
                    // The field holds a bare number, empty for none: the download says the saved amount.
                    exportValue={live && index === ADJUSTMENT ? formatMinor(row.adjustment, currency) : undefined}
                  >
                    {live && index === ADJUSTMENT ? (
                      <AdjustmentCell company={company} month={month} row={row} />
                    ) : (
                      <Amount minor={minor} currency={currency} />
                    )}
                  </DataCell>
                ))}
                {live && (
                  <DataCell actions>
                    <RowActions row={row} onEdit={() => onEdit(row.personId)} />
                  </DataCell>
                )}
              </DataRow>
              {expanded && (
                <DataRow plain>
                  <DataCell colSpan={span}>
                    <Breakdown company={company} month={month} row={row} live={live} />
                  </DataCell>
                </DataRow>
              )}
            </Fragment>
          );
        })}
      </DataBody>
      <DataFoot>
        {foot.map(({ label, cells, strong }) => (
          <DataRow key={label} plain>
            <DataRowHeader pinned className={strong ? "font-semibold" : "font-medium"}>
              {label}
            </DataRowHeader>
            {cells.map((cell, index) => (
              <DataCell
                key={index}
                numeric
                group={COLUMNS[index]!.group}
                strong={COLUMNS[index]!.strong}
                className={cn(strong && "font-semibold")}
              >
                {cell}
              </DataCell>
            ))}
            {live && <DataCell />}
          </DataRow>
        ))}
      </DataFoot>
    </DataTable>
  );
}

/** The foot's rows: one a kind where there are two, then the total. */
function footRows<T>(
  byKind: Record<PayrollKind, T>,
  overall: T,
  people: (totals: T) => number,
  cells: (totals: T, kind: PayrollKind | null) => readonly ReactNode[],
): FootRow[] {
  const kinds = PAYROLL_KINDS.filter((kind) => people(byKind[kind]) > 0);
  return [
    ...(kinds.length > 1
      ? kinds.map((kind) => ({
          label: `${KIND_PLURALS[kind]} (${people(byKind[kind])})`,
          cells: cells(byKind[kind], kind),
        }))
      : []),
    {
      label: `Total (${plural(people(overall), "person", "people")})`,
      cells: cells(overall, null),
      strong: true,
    },
  ];
}

/** A live foot: each figure whole, or said to be not known, from payroll's own `summarise`. */
function liveFoot(set: CurrencySummary, rows: readonly RunRow[]): FootRow[] {
  const { currency } = set;
  const adjusted = (kind: PayrollKind | null) =>
    rows
      .filter((row) => kind === null || row.kind === kind)
      .reduce((sum, row) => sum + row.adjustment, 0);
  return footRows<SummaryTotals>(
    set.byKind,
    set.overall,
    (totals) => totals.people,
    (totals, kind) => [
      <FigureCell key="gross" figure={totals.gross} totals={totals} currency={currency} />,
      <Money key="adjustment" minor={adjusted(kind)} currency={currency} />,
      <FigureCell key="withheld" figure={totals.withheld} totals={totals} currency={currency} />,
      <FigureCell key="net" figure={totals.net} totals={totals} currency={currency} partial />,
      <FigureCell key="paid" figure={totals.companyPaid} totals={totals} currency={currency} />,
      <FigureCell key="cost" figure={totals.cost} totals={totals} currency={currency} />,
    ],
  );
}

/** A paid month's foot: its frozen totals, every one of them whole. */
function paidFoot(set: Run["totals"][number]): FootRow[] {
  return footRows<Totals>(
    set.byKind,
    set.overall,
    (totals) => totals.people,
    (totals) =>
      [
        totals.gross,
        totals.adjustment,
        totals.withheld,
        totals.net,
        totals.companyPaid,
        totals.cost,
      ].map((minor, index) => <Money key={index} minor={minor} currency={set.currency} />),
  );
}

const ApartNote = () => (
  <p className="text-xs text-ink-3">
    Amounts in different currencies are never added together: each currency has its own table and
    its own totals.
  </p>
);

// ── Marking paid, and reopening ─────────────────────────────────────────────

/** Mark the month paid: what freezing means, and the date, asked before anything is sent. */
function MarkPaidDialog({
  company,
  month,
  today,
  onClose,
}: {
  company: CompanyId;
  month: string;
  today: string;
  onClose: () => void;
}) {
  const markPaid = useMutation(api.payroll.markPaid);
  const [paidOn, setPaidOn] = useState(today);
  const { busy, error, run } = useAction();
  const paidId = useId();
  const name = formatPeriod("month", month);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-card p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">Mark {name} as paid?</DialogTitle>
          <DialogDescription className="text-sm text-ink-2">
            This freezes {name} as the table shows it now: later changes to people, pay or rates do
            not change its figures. It records the payment; it moves no money. Reopen it to change
            it.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => markPaid({ company, month, paidOn })).then((done) => done && onClose());
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5 sm:w-48">
            <Label htmlFor={paidId}>Paid on</Label>
            <input
              id={paidId}
              type="date"
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
              className={`${fieldClass} h-10`}
            />
          </div>
          <Failure error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={quietButtonClass}>
              Cancel
            </button>
            <ActionButton type="submit" busy={busy} className={primaryButtonClass}>
              Mark as paid
            </ActionButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── The month ───────────────────────────────────────────────────────────────

type MonthProps = {
  company: CompanyId;
  month: string;
  now: number;
  /** Undefined while loading, null where nothing is saved. */
  run: Run | null | undefined;
  people: readonly Person[] | undefined;
  lines: readonly Line[] | undefined;
};

/**
 * A month that is not paid: one row per person on payroll that month, worked
 * out as you look from today's people and lines, the same arithmetic marking
 * it paid freezes. A draft saved for the month is read only for its
 * adjustments; its other figures are not shown.
 */
function LiveMonth({
  company,
  month,
  now,
  run,
  people,
  lines,
  onEdit,
}: Omit<MonthProps, "run" | "people" | "lines"> & {
  run: Run | null;
  people: readonly Person[];
  lines: readonly Line[];
  onEdit: (id: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const name = formatPeriod("month", month);
  const companyCurrency = MARKET_CURRENCY[company];

  const worked = useMemo(() => {
    const adjustments = new Map(
      (run?.rows ?? [])
        .filter((row) => row.adjustment !== 0)
        .map((row) => [
          row.personId as string,
          { amount: row.adjustment, note: row.adjustmentNote ?? undefined },
        ]),
    );
    const input = { people, lines, month, companyCurrency, adjustments };
    try {
      return { rows: draftRows(input).map(readRow), sets: summarise(input) };
    } catch {
      // Lines that subtract each other in a circle: nothing can be worked out.
      return null;
    }
  }, [run, people, lines, month, companyCurrency]);

  if (worked === null) return <CircleNote />;
  const rows = worked.rows as RunRow[];
  const sets = worked.sets.filter((set) => set.overall.people > 0);

  const notComputed = rows.reduce((sum, row) => sum + row.notComputed, 0);
  const blocked = notComputed > 0 || rows.some((row) => row.gross === null);
  const rates = sets.reduce((sum, set) => sum + set.gaps.withheldRates + set.gaps.companyRates, 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className="max-w-xl text-sm text-ink-2">
          {rows.length === 0
            ? `Nobody is on payroll in ${name}. Add a person, or open another month.`
            : "Worked out as you look, from today's people, pay and rates. Marking the month paid freezes it."}
        </p>
        <div className="-mr-2 flex flex-wrap items-center gap-1">
          <button type="button" onClick={() => onEdit("new")} className={quietButtonClass}>
            <UserPlusIcon aria-hidden className="size-4" />
            Add a person
          </button>
          {rows.length > 0 && (
            <ActionButton
              blocked={blocked}
              icon={<CheckIcon aria-hidden className="size-4" />}
              className={primaryButtonClass}
              onClick={() => {
                // Why not is said just below; nothing is asked or sent.
                if (!blocked) setAsking(true);
              }}
            >
              Mark as paid
            </ActionButton>
          )}
        </div>
      </div>

      {blocked && (
        <p className="text-sm text-ink">
          {name} cannot be marked paid yet:{" "}
          {rates > 0
            ? `${plural(rates, "rate is", "rates are")} not set`
            : `${plural(notComputed, "line is", "lines are")} not computed`}
          . Set each rate below, or switch the line off.
        </p>
      )}

      {sets.map((set) => (
        <div key={set.currency} className="space-y-3">
          <MonthSummary set={set} companyCurrency={companyCurrency} />
          <MonthTable
            company={company}
            month={month}
            currency={set.currency}
            rows={rows.filter((row) => row.currency === set.currency)}
            foot={liveFoot(set, rows.filter((row) => row.currency === set.currency))}
            live
            onEdit={onEdit}
          />
        </div>
      ))}
      {sets.length > 1 && <ApartNote />}

      {asking && (
        <MarkPaidDialog
          company={company}
          month={month}
          today={localIsoDate(now)}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

/** A paid month: the frozen copy, read-only, and the way to reopen it. */
function PaidMonth({ company, month, now, run }: { company: CompanyId; month: string; now: number; run: Run }) {
  const reopen = useMutation(api.payroll.reopenRun);
  const [asking, setAsking] = useState(false);
  const { busy, error, setError, run: act } = useAction();
  const name = formatPeriod("month", month);
  const sets = run.totals.filter((set) => set.overall.people > 0);
  const paid = run.paidOn === null ? "Paid" : `Paid on ${dayLabel(run.paidOn, now)}`;

  return (
    <>
      {asking ? (
        <Confirm
          question={`Reopen ${name}? It is no longer marked paid, and its figures are worked out again from today's people, pay and rates. Its adjustments are kept.`}
          confirm="Reopen month"
          cancel="Keep it paid"
          busy={busy}
          onConfirm={() =>
            void act(() => reopen({ company, month })).then((done) => done && setAsking(false))
          }
          onCancel={() => setAsking(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="max-w-xl text-sm text-ink-2">
            {paid}; later changes to people or rates do not change it.
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setAsking(true);
            }}
            className={cn(quietButtonClass, "-mr-2")}
          >
            <RotateCcwIcon aria-hidden className="size-4" />
            Reopen
          </button>
        </div>
      )}
      <Failure error={error} />
      {sets.map((set) => (
        <MonthTable
          key={set.currency}
          company={company}
          month={month}
          currency={set.currency}
          rows={run.rows.filter((row) => row.currency === set.currency)}
          foot={paidFoot(set)}
          live={false}
          onEdit={() => {}}
        />
      ))}
      {sets.length > 1 && <ApartNote />}
    </>
  );
}

/**
 * What a month holds, and everyone the company pays who is not in it.
 * Mounted afresh for each company and month, so nothing typed, opened or
 * refused in one follows into another.
 */
function MonthBody({ company, month, now, run, people, lines }: MonthProps) {
  // The id of the person being edited, "new" for the add form, or null.
  const [editing, setEditing] = useState<string | null>(null);
  if (run === undefined || people === undefined || lines === undefined) {
    return <Skeleton className="h-32 rounded-inner" />;
  }
  const paid = run !== null && run.status === "paid";
  const inTable = new Set<string>(
    paid ? run.rows.map((row) => row.personId) : people.filter((p) => activeIn(p, month)).map((p) => p.id),
  );
  const waiting = people.filter((p) => p.archivedAt === null && !inTable.has(p.id));
  const archived = people.filter((p) => p.archivedAt !== null);
  const edited = people.find((p) => p.id === editing) ?? null;

  return (
    <>
      {paid ? (
        <PaidMonth company={company} month={month} now={now} run={run} />
      ) : (
        <LiveMonth
          company={company}
          month={month}
          now={now}
          run={run}
          people={people}
          lines={lines}
          onEdit={setEditing}
        />
      )}
      <OtherPeople
        monthName={formatPeriod("month", month)}
        waiting={waiting}
        archived={archived}
        now={now}
        onEdit={setEditing}
      />
      {/* Mounted once per opening, so the form's fields are its own draft. */}
      {editing === "new" && (
        <PersonEditor company={company} person={null} lines={lines} onClose={() => setEditing(null)} />
      )}
      {editing !== null && editing !== "new" && edited !== null && (
        <PersonEditor
          key={editing}
          company={company}
          person={edited}
          lines={lines}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/**
 * One month of one company's payroll, in one table: who is paid what, what is
 * withheld, what the company pays on top, and what it all costs. Until the
 * month is marked paid the table is live, from today's people and lines;
 * marking it paid freezes it, read-only until it is reopened.
 */
export function MonthPanel({
  onMonth,
  headingRef,
  ...props
}: MonthProps & {
  onMonth: (month: string | null) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { company, month, now, run } = props;
  const name = formatPeriod("month", month);
  const isCurrent = month === monthOf(now);
  const paid = run != null && run.status === "paid";

  return (
    <Panel aria-label="Month">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg outline-none">
            {name}
          </h2>
          {/* The same chip the month wears in History below, so the two cannot differ. */}
          {paid ? (
            <RunStatus status="paid">
              {run.paidOn !== null ? `Paid on ${dayLabel(run.paidOn, now)}` : "Paid"}
            </RunStatus>
          ) : (
            <StatusChip tone="neutral">{run === undefined ? "Loading" : "Not paid"}</StatusChip>
          )}
        </div>
        <div className="-mr-2 flex items-center gap-1">
          {!isCurrent && (
            <button type="button" onClick={() => onMonth(null)} className={quietButtonClass}>
              Back to this month
            </button>
          )}
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => onMonth(previousPeriodStart("month", month))}
            className={cn(quietButtonClass, "w-10 px-0")}
          >
            <ChevronLeftIcon aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => onMonth(nextPeriodStart("month", month))}
            className={cn(quietButtonClass, "w-10 px-0")}
          >
            <ChevronRightIcon aria-hidden className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-5">
        <MonthBody key={`${company}:${month}`} {...props} />
      </div>
    </Panel>
  );
}
