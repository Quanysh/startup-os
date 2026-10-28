"use client";

import { useMutation } from "convex/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleOffIcon,
  ListPlusIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import { MAX_LINE_NAME_LENGTH, MAX_PAYROLL_LINES } from "@convex/lib/limits";
import type { Currency } from "@convex/lib/metricRegistry";
import {
  KIND_PLURALS,
  PAYERS,
  PAYER_LABELS,
  PAYROLL_KINDS,
  type Payer,
  type PayrollKind,
} from "@convex/lib/payroll";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
  rowIconActionClass,
} from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { formatMinor } from "@/lib/format";
import { formatRate, moneyInput, parseMoney, parsePercent, percentInput } from "@/lib/payroll/input";
import { cn } from "@/lib/utils";
import {
  ActionButton,
  CURRENCY_NAMES,
  Failure,
  PaidBy,
  RateNotSet,
  useAction,
  type Line,
} from "./shared";

const PAYER_HINTS: Record<Payer, string> = {
  employee: "lowers net pay",
  company: "on top of gross: raises total cost",
};
const USUAL_FOR: Record<CompanyId, string> = { us: "the United States'", kz: "Kazakhstan's" };
const RATE_RULE = "A rate is from 0% to 100%, with two decimals at most.";

/** What a line's rate is taken on, in one cell: "gross − Pension − ₸50,000 allowance, capped at …". */
function baseOf(line: Line, lines: readonly Line[], currency: Currency): string {
  const less = line.lessLineIds
    .map((id) => lines.find((other) => other.id === id)?.name)
    .filter((name) => name !== undefined);
  return [
    "gross",
    ...less.map((name) => ` − ${name}`),
    line.allowance > 0 ? ` − ${formatMinor(line.allowance, currency)} allowance` : "",
    line.baseCap !== null ? `, capped at ${formatMinor(line.baseCap, currency)}` : "",
  ].join("");
}

/**
 * Add a line, or edit one. The fields are read from the line once, when the
 * editor opens. A rate left blank is "not set", which is not zero: the line
 * is then not computed, and a month that holds it cannot be marked paid.
 */
function LineEditor({
  company,
  kind,
  line,
  siblings,
  onClose,
}: {
  company: CompanyId;
  kind: PayrollKind;
  /** The line being edited, or null to add one. */
  line: Line | null;
  /** The other lines of the same kind: what this one's base can be less. */
  siblings: readonly Line[];
  onClose: () => void;
}) {
  const create = useMutation(api.payroll.createLine);
  const update = useMutation(api.payroll.updateLine);
  const remove = useMutation(api.payroll.removeLine);
  const currency = MARKET_CURRENCY[company];

  const [name, setName] = useState(line?.name ?? "");
  const [paidBy, setPaidBy] = useState<Payer>(line?.paidBy ?? "employee");
  const [rate, setRate] = useState(line?.rateBp == null ? "" : percentInput(line.rateBp));
  const [less, setLess] = useState<Line["id"][]>(line?.lessLineIds ?? []);
  const [allowance, setAllowance] = useState(
    line === null || line.allowance === 0 ? "" : moneyInput(line.allowance),
  );
  const [cap, setCap] = useState(line?.baseCap == null ? "" : moneyInput(line.baseCap));
  const [active, setActive] = useState(line?.active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, setError, run } = useAction();

  const ids = {
    name: useId(),
    paidBy: useId(),
    rate: useId(),
    rateHint: useId(),
    allowance: useId(),
    cap: useId(),
    active: useId(),
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    // The server decides; these only save a round trip, in its own words.
    if (name.trim() === "") return setError("A line needs a name.");
    if (name.trim().length > MAX_LINE_NAME_LENGTH) {
      return setError(`That name is too long (${MAX_LINE_NAME_LENGTH} characters at most).`);
    }
    const rateBp = rate.trim() === "" ? null : parsePercent(rate);
    if (rate.trim() !== "" && rateBp === null) return setError(RATE_RULE);
    const allowanceMinor = allowance.trim() === "" ? 0 : parseMoney(allowance);
    if (allowanceMinor === null) return setError("The allowance is not an amount.");
    const capMinor = cap.trim() === "" ? null : parseMoney(cap);
    if (cap.trim() !== "" && capMinor === null) return setError("The cap is not an amount.");
    // In the list's order, whatever order the boxes were ticked in.
    const lessLineIds = siblings.filter((other) => less.includes(other.id)).map((other) => other.id);

    const saved = await run(() =>
      line === null
        ? create({
            company,
            appliesTo: kind,
            name,
            paidBy,
            ...(rateBp !== null ? { rateBp } : null),
            lessLineIds,
            allowance: allowanceMinor,
            ...(capMinor !== null ? { baseCap: capMinor } : null),
            active,
          })
        : update({
            id: line.id,
            name,
            paidBy,
            rateBp,
            lessLineIds,
            allowance: allowanceMinor,
            baseCap: capMinor,
            active,
          }),
    );
    if (saved) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">{line === null ? "Add a line" : "Edit line"}</DialogTitle>
          <DialogDescription>
            For {KIND_PLURALS[kind].toLowerCase()}. A change reaches no month already saved until
            its draft is recalculated.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <input
              id={ids.name}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${fieldClass} h-10`}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.paidBy}>Paid by</Label>
              <select
                id={ids.paidBy}
                value={paidBy}
                onChange={(e) => setPaidBy(e.target.value as Payer)}
                className={`${fieldClass} h-10`}
              >
                {PAYERS.map((id) => (
                  <option key={id} value={id}>
                    {PAYER_LABELS[id]} ({PAYER_HINTS[id]})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.rate}>Rate (%)</Label>
              <input
                id={ids.rate}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={ids.rateHint}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className={`${fieldClass} h-10 text-right font-num`}
              />
            </div>
          </div>
          <p id={ids.rateHint} className="text-xs text-ink-3">
            The rate is yours to set. Leave it blank until you have it: the line then reads
            &ldquo;Rate not set&rdquo; and is not computed, which is not the same as 0%.
          </p>

          <fieldset>
            <legend className="text-sm font-medium text-ink">Base: gross, less</legend>
            {siblings.length === 0 ? (
              <p className="mt-1.5 text-xs text-ink-3">
                No other line for {KIND_PLURALS[kind].toLowerCase()} yet to subtract.
              </p>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
                {siblings.map((other) => (
                  <label key={other.id} className="flex min-h-6 items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={less.includes(other.id)}
                      onChange={(e) =>
                        setLess((was) =>
                          e.target.checked ? [...was, other.id] : was.filter((id) => id !== other.id),
                        )
                      }
                      className="size-4 accent-brand"
                    />
                    {other.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.allowance}>Allowance</Label>
              <input
                id={ids.allowance}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={allowance}
                onChange={(e) => setAllowance(e.target.value)}
                className={`${fieldClass} h-10 text-right font-num`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.cap}>Cap</Label>
              <input
                id={ids.cap}
                inputMode="decimal"
                autoComplete="off"
                placeholder="None"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className={`${fieldClass} h-10 text-right font-num`}
              />
            </div>
          </div>
          <p className="text-xs text-ink-3">
            Both in {CURRENCY_NAMES[currency]} a month. The allowance comes off the base, which
            never goes below zero; the cap is the most the base can be. For someone paid in another
            currency a line with either is not computed.
          </p>

          <label htmlFor={ids.active} className="flex items-center gap-2 text-sm text-ink">
            <input
              id={ids.active}
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="size-4 accent-brand"
            />
            On
          </label>

          <Failure error={error} />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {line === null ? (
              <span />
            ) : confirmDelete ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                Delete this line?
                <button
                  type="button"
                  onClick={async () => {
                    const gone = await run(
                      () => remove({ id: line.id }),
                      "That line could not be deleted. Try again.",
                    );
                    if (gone) onClose();
                    else setConfirmDelete(false);
                  }}
                  className="rounded-full px-3 py-1.5 font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full px-3 py-1.5 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className={`${quietButtonClass} -ml-3 hover:text-destructive`}
              >
                <Trash2Icon aria-hidden className="size-4" />
                Delete
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={quietButtonClass}>
                Cancel
              </button>
              <ActionButton type="submit" busy={busy} className={primaryButtonClass}>
                Save
              </ActionButton>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One kind's lines, in the order they are worked out and shown, each with its controls. */
function KindLines({
  company,
  kind,
  lines,
  onEdit,
  onAdd,
}: {
  company: CompanyId;
  kind: PayrollKind;
  lines: readonly Line[];
  onEdit: (line: Line) => void;
  onAdd: () => void;
}) {
  const update = useMutation(api.payroll.updateLine);
  const reorder = useMutation(api.payroll.reorderLines);
  const { busy, error, run } = useAction();
  const headingId = useId();
  const plural = KIND_PLURALS[kind];
  const currency = MARKET_CURRENCY[company];

  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= lines.length) return;
    const ids = lines.map((line) => line.id);
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    void run(() => reorder({ company, appliesTo: kind, ids }));
  };

  return (
    <div>
      <h3 id={headingId} className="text-sm font-medium text-ink">
        {plural}
      </h3>
      {lines.length === 0 ? (
        <p className="mt-1 text-sm text-ink-3">No lines yet.</p>
      ) : (
        <DataTable
          caption={`Lines for ${plural.toLowerCase()}`}
          className="min-w-[44rem]"
          boxClassName="mt-1"
        >
          <DataHead>
            <DataHeader pinned>Line</DataHeader>
            <DataHeader>Paid by</DataHeader>
            <DataHeader numeric>Rate</DataHeader>
            <DataHeader>Base</DataHeader>
            {/* Controls, not in the download: a line's cell says "Switched off", and the rows are in order. */}
            <DataHeader noExport>On</DataHeader>
            <DataHeader noExport>Order</DataHeader>
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {lines.map((line, index) => {
              const dim = !line.active && "opacity-60";
              return (
                <DataRow key={line.id}>
                  <DataRowHeader pinned>
                    <span className={cn("block", dim)}>{line.name}</span>
                    {!line.active && (
                      <StatusChip tone="neutral" icon={CircleOffIcon} className="mt-1">
                        Switched off
                      </StatusChip>
                    )}
                  </DataRowHeader>
                  <DataCell className={cn("whitespace-nowrap", dim)}>
                    <PaidBy payer={line.paidBy} />
                  </DataCell>
                  <DataCell numeric className={cn(dim)}>
                    {line.rateBp === null ? <RateNotSet /> : formatRate(line.rateBp)}
                  </DataCell>
                  <DataCell className={cn("min-w-[12rem] text-ink-2", dim)}>
                    {baseOf(line, lines, currency)}
                  </DataCell>
                  <DataCell actions className="text-left">
                    <label className="inline-flex h-9 items-center">
                      <input
                        type="checkbox"
                        aria-label={`${line.name} is on`}
                        checked={line.active}
                        onChange={(e) =>
                          void run(() => update({ id: line.id, active: e.target.checked }))
                        }
                        className="size-4 accent-brand"
                      />
                    </label>
                  </DataCell>
                  <DataCell actions className="text-left">
                    <span className="-ml-2 inline-flex">
                      <ActionButton
                        blocked={index === 0}
                        busy={busy}
                        aria-label={`Move ${line.name} up`}
                        className={rowIconActionClass}
                        onClick={() => move(index, -1)}
                      >
                        {!busy && <ArrowUpIcon aria-hidden className="size-4" />}
                      </ActionButton>
                      <ActionButton
                        blocked={index === lines.length - 1}
                        busy={busy}
                        aria-label={`Move ${line.name} down`}
                        className={rowIconActionClass}
                        onClick={() => move(index, 1)}
                      >
                        {!busy && <ArrowDownIcon aria-hidden className="size-4" />}
                      </ActionButton>
                    </span>
                  </DataCell>
                  <DataCell actions>
                    <button type="button" onClick={() => onEdit(line)} className={rowActionClass}>
                      <PencilIcon aria-hidden className="size-4" />
                      Edit<span className="sr-only"> {line.name}</span>
                    </button>
                  </DataCell>
                </DataRow>
              );
            })}
          </DataBody>
        </DataTable>
      )}
      <Failure error={error} className="mt-2" />
      <button type="button" onClick={onAdd} className={`${quietButtonClass} mt-1 -ml-3`}>
        <PlusIcon aria-hidden className="size-4" />
        Add a line<span className="sr-only"> for {plural.toLowerCase()}</span>
      </button>
    </div>
  );
}

/**
 * A company's tax and contribution lines, per kind of person. Every rate on
 * this panel was typed by the owner. The OS offers names; it never offers,
 * fills in or checks a rate.
 */
export function LinesPanel({
  company,
  lines,
}: {
  company: CompanyId;
  lines: readonly Line[] | undefined;
}) {
  const addUsual = useMutation(api.payroll.addUsualLines);
  const [editing, setEditing] = useState<{ kind: PayrollKind; id: string | null } | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const ofKind = (kind: PayrollKind) => lines?.filter((line) => line.appliesTo === kind) ?? [];
  const edited =
    editing === null ? null : (ofKind(editing.kind).find((line) => line.id === editing.id) ?? null);

  return (
    <Panel aria-labelledby="payroll-lines">
      <h2 id="payroll-lines" className="text-base">
        Tax and contribution lines
      </h2>
      <div className="mt-1 max-w-2xl space-y-1.5 text-sm text-ink-2">
        <p>
          What is withheld from pay and what the company pays on top, for {COMPANIES[company].name}.
          Up to {MAX_PAYROLL_LINES} lines.
        </p>
        <p className="text-ink">
          The rates are yours to set and to confirm with your accountant. The OS does the
          arithmetic from the rates you type: it knows no tax law, checks no rate, and does not
          keep them up to date. It is not tax advice.
        </p>
      </div>

      {lines === undefined ? (
        <Skeleton className="mt-4 h-24 rounded-inner" />
      ) : (
        <div className="mt-5 space-y-6">
          {PAYROLL_KINDS.map((kind) => (
            <KindLines
              key={kind}
              company={company}
              kind={kind}
              lines={ofKind(kind)}
              onEdit={(line) => setEditing({ kind, id: line.id })}
              onAdd={() => setEditing({ kind, id: null })}
            />
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {PAYROLL_KINDS.map((kind) => (
            <ActionButton
              key={kind}
              busy={busy}
              icon={<ListPlusIcon aria-hidden className="size-4" />}
              className={`${quietButtonClass} -ml-3`}
              onClick={async () => {
                setAdded(null);
                await run(async () => setAdded(await addUsual({ company, appliesTo: kind })));
              }}
            >
              {kind === "employee"
                ? "Add the usual lines for employees"
                : "Add the usual lines for contractors"}
            </ActionButton>
          ))}
          {added !== null && (
            <p role="status" className="text-sm text-ink">
              {added === 0
                ? "The usual lines are all there already."
                : `${added} ${added === 1 ? "line" : "lines"} added, each with no rate.`}
            </p>
          )}
        </div>
        <p className="mt-1 max-w-2xl text-xs text-ink-3">
          Adds {USUAL_FOR[company]} usual line names to employees or to contractors, where they are
          not there yet. The two keep their own rates. Names only: every rate is left for you to
          type, and so is what each base is less.
        </p>
        <Failure error={error} className="mt-2" />
      </div>

      {editing !== null && (editing.id === null || edited !== null) && (
        <LineEditor
          key={editing.id ?? "new"}
          company={company}
          kind={editing.kind}
          line={edited}
          siblings={ofKind(editing.kind).filter((line) => line.id !== editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}
