"use client";

import { useMutation } from "convex/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { MARKET_CURRENCY, offeredCurrencies, startingCurrencyOf } from "@convex/lib/customerShape";
import { MAX_NAME_LENGTH, MAX_PAYROLL_NOTE_LENGTH } from "@convex/lib/limits";
import type { Currency } from "@convex/lib/metricRegistry";
import {
  KIND_LABELS,
  KIND_PLURALS,
  PAYROLL_KINDS,
  grossForNet,
  linesFor,
  timeSharesProblem,
  type PayrollKind,
} from "@convex/lib/payroll";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ActionsHeader,
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
} from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import type { CompanyId } from "@/lib/company";
import { dayLabel, formatMinor } from "@/lib/format";
import { moneyInput, parseMoney } from "@/lib/payroll/input";
import {
  PersonKind,
  ActionButton,
  CURRENCY_NAMES,
  Failure,
  Money,
  useAction,
  type Line,
  type Person,
} from "./shared";

type Basis = Person["payBasis"];
const BASIS_LABELS: Record<Basis, string> = { net: "Monthly net", gross: "Monthly gross" };
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A typed share of time: blank is 0, anything not a number is NaN (and refused). */
const shareOf = (typed: string) => (typed.trim() === "" ? 0 : Number(typed.trim().replace(/%$/, "")));

/**
 * What a typed net comes to, in words, from the lines as they are now: the
 * gross it works out to, or why none can be worked out. Never a guess: the
 * same arithmetic the server saves a month with.
 */
function grossLine(input: {
  net: number;
  kind: PayrollKind;
  currency: Currency;
  companyCurrency: Currency;
  lines: readonly Line[];
}): string {
  const { net, kind, currency, companyCurrency, lines } = input;
  let up;
  try {
    up = grossForNet({
      net,
      sameCurrency: currency === companyCurrency,
      lines: linesFor(lines, kind),
    });
  } catch {
    return "Gross cannot be worked out: the lines subtract each other in a circle.";
  }
  if (up.known) {
    const said = `Gross works out to ${formatMinor(up.gross, currency)} (net ${formatMinor(up.net, currency)} after ${formatMinor(up.gross - up.net, currency)} withheld)`;
    return up.over === 0
      ? said
      : `${said}. That is ${formatMinor(up.over, currency)} more than the net entered: no gross gives it exactly.`;
  }
  if (up.reason === "rate_not_set") {
    return `Gross cannot be worked out until ${count(up.count, "rate is", "rates are")} set.`;
  }
  if (up.reason === "other_currency") {
    return `Gross cannot be worked out: ${count(up.count, "line", "lines")} withheld from pay ${up.count === 1 ? "has" : "have"} an allowance or a cap in ${CURRENCY_NAMES[companyCurrency]}, which is not computed for someone paid in ${CURRENCY_NAMES[currency]}.`;
  }
  return "Gross cannot be worked out: with these rates, what is withheld leaves no gross that gives this net.";
}

/**
 * Add a person, or edit one. The fields are read from the person once, when
 * the editor opens: a live update arriving while it is open never replaces
 * what has been typed.
 *
 * Pay is entered as net (what the person receives) unless the owner switches
 * to gross. For a net the gross is never typed or sent: the line under the
 * field says what it works out to from today's lines, and each month works
 * it out again when it is prepared.
 */
export function PersonEditor({
  company,
  person,
  lines,
  onClose,
}: {
  company: CompanyId;
  /** The person being edited, or null to add one. */
  person: Person | null;
  /** The company's lines as they are now; undefined while loading. */
  lines: readonly Line[] | undefined;
  onClose: () => void;
}) {
  const create = useMutation(api.payroll.createPerson);
  const update = useMutation(api.payroll.updatePerson);
  const archive = useMutation(api.payroll.archivePerson);
  const remove = useMutation(api.payroll.removePerson);

  const [name, setName] = useState(person?.name ?? "");
  const [title, setTitle] = useState(person?.title ?? "");
  const [kind, setKind] = useState<PayrollKind>(person?.kind ?? "employee");
  const [currency, setCurrency] = useState<Currency>(person?.currency ?? startingCurrencyOf(company));
  // A new person is entered as net; an existing one as they were.
  const [basis, setBasis] = useState<Basis>(person?.payBasis ?? "net");
  const [pay, setPay] = useState(() => {
    const figure = person?.payBasis === "net" ? person.monthlyNet : person?.monthlyGross;
    return figure == null ? "" : moneyInput(figure);
  });
  const [startDate, setStartDate] = useState(person?.startDate ?? "");
  const [endDate, setEndDate] = useState(person?.endDate ?? "");
  const [notes, setNotes] = useState(person?.notes ?? "");
  // Shares of time, for unit economics on Finance. Absent on a person is 0.
  const keptCogs = person?.cogsPercent ?? 0;
  const keptSales = person?.salesPercent ?? 0;
  const [cogsShare, setCogsShare] = useState(String(keptCogs));
  const [salesShare, setSalesShare] = useState(String(keptSales));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, setError, run } = useAction();

  const ids = {
    name: useId(),
    title: useId(),
    kind: useId(),
    currency: useId(),
    pay: useId(),
    payHint: useId(),
    start: useId(),
    end: useId(),
    notes: useId(),
    cogs: useId(),
    sales: useId(),
    sharesHint: useId(),
  };

  const companyCurrency = MARKET_CURRENCY[company];
  const typed = parseMoney(pay);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    // The server decides; these only save a round trip, in its own words.
    if (name.trim() === "") return setError("A person needs a name.");
    if (name.trim().length > MAX_NAME_LENGTH) {
      return setError(`That name is too long (${MAX_NAME_LENGTH} characters at most).`);
    }
    const figure = parseMoney(pay);
    if (figure === null) return setError(`The ${BASIS_LABELS[basis].toLowerCase()} is not an amount.`);
    // The figure that goes with the basis, and only that one.
    const entered =
      basis === "net"
        ? { payBasis: "net" as const, monthlyNet: figure }
        : { payBasis: "gross" as const, monthlyGross: figure };
    if (notes.trim().length > MAX_PAYROLL_NOTE_LENGTH) {
      return setError(`That note is too long (${MAX_PAYROLL_NOTE_LENGTH} characters at most).`);
    }
    const cogsPercent = shareOf(cogsShare);
    const salesPercent = shareOf(salesShare);
    const sharesProblem = timeSharesProblem(cogsPercent, salesPercent);
    if (sharesProblem !== null) return setError(sharesProblem);
    // A share is sent when it says something new: a new person's above 0, an edit's when changed.
    const shares = {
      ...(cogsPercent !== keptCogs ? { cogsPercent } : null),
      ...(salesPercent !== keptSales ? { salesPercent } : null),
    };
    const saved = await run(() =>
      person === null
        ? create({
            company,
            name,
            ...(title.trim() !== "" ? { title } : null),
            kind,
            ...entered,
            currency,
            ...(startDate !== "" ? { startDate } : null),
            ...(endDate !== "" ? { endDate } : null),
            ...(notes.trim() !== "" ? { notes } : null),
            ...shares,
          })
        : update({
            id: person.id,
            name,
            title: title.trim() === "" ? null : title,
            kind,
            ...entered,
            currency,
            startDate: startDate === "" ? null : startDate,
            endDate: endDate === "" ? null : endDate,
            notes: notes.trim() === "" ? null : notes,
            ...shares,
          }),
    );
    if (saved) onClose();
  };

  const close = async (work: () => Promise<unknown>, fallback: string) => {
    if (await run(work, fallback)) onClose();
    else setConfirmDelete(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {person === null ? "Add a person" : "Edit person"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Who is paid, as an employee or a contractor, how much a month, and from when.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
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
            <div className="space-y-1.5">
              <Label htmlFor={ids.title}>Title</Label>
              <input
                id={ids.title}
                autoComplete="off"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.kind}>Kind</Label>
              <select
                id={ids.kind}
                value={kind}
                onChange={(e) => setKind(e.target.value as PayrollKind)}
                className={`${fieldClass} h-10`}
              >
                {PAYROLL_KINDS.map((id) => (
                  <option key={id} value={id}>
                    {KIND_LABELS[id]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.currency}>Paid in</Label>
              <select
                id={ids.currency}
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                className={`${fieldClass} h-10`}
              >
                {offeredCurrencies().map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <Label htmlFor={ids.pay}>{BASIS_LABELS[basis]}</Label>
                <button
                  type="button"
                  onClick={() => setBasis(basis === "net" ? "gross" : "net")}
                  className="rounded-inner text-xs font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {basis === "net" ? "Enter gross instead" : "Enter net instead"}
                </button>
              </div>
              <input
                id={ids.pay}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={ids.payHint}
                value={pay}
                onChange={(e) => setPay(e.target.value)}
                className={`${fieldClass} h-10 text-right font-num`}
              />
              <p id={ids.payHint} data-testid="gross-line" aria-live="polite" className="text-xs text-ink">
                {basis === "gross"
                  ? "What they are paid each month, before anything is withheld."
                  : typed === null || lines === undefined
                    ? `What they receive each month, after everything withheld. The gross is worked out from the lines for ${KIND_PLURALS[kind].toLowerCase()}.`
                    : grossLine({ net: typed, kind, currency, companyCurrency, lines })}
              </p>
              <p className="text-xs text-ink-3">
                In {CURRENCY_NAMES[currency]}. A month not yet paid shows the change at once; a paid
                month keeps the figures it was paid with
                {basis === "net" && ", the gross worked out from the lines as they were then"}.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.start}>Start date</Label>
              <input
                id={ids.start}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.end}>End date</Label>
              <input
                id={ids.end}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
          </div>
          <p className="text-xs text-ink-3">
            A month holds everyone who started on or before its last day and had not ended before
            its first. The full monthly gross is used: a part month is not prorated.
          </p>

          <fieldset className="space-y-1.5" aria-describedby={ids.sharesHint}>
            <legend className="text-sm font-medium text-ink">Where their time goes</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={ids.cogs}>Time serving customers (%)</Label>
                <input
                  id={ids.cogs}
                  inputMode="numeric"
                  autoComplete="off"
                  value={cogsShare}
                  onChange={(e) => setCogsShare(e.target.value)}
                  className={`${fieldClass} h-10 text-right font-num`}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={ids.sales}>Time on sales and marketing (%)</Label>
                <input
                  id={ids.sales}
                  inputMode="numeric"
                  autoComplete="off"
                  value={salesShare}
                  onChange={(e) => setSalesShare(e.target.value)}
                  className={`${fieldClass} h-10 text-right font-num`}
                />
              </div>
            </div>
            <p id={ids.sharesHint} className="text-xs text-ink-3">
              Your estimate, for unit economics on Finance: that share of their total cost counts in the cost of
              serving customers, and in what winning one costs. The rest is running the company. Finance shows
              these only added up, never a person&apos;s.
            </p>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor={ids.notes}>Notes</Label>
            <input
              id={ids.notes}
              autoComplete="off"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`${fieldClass} h-10`}
            />
          </div>

          <Failure error={error} />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {person === null ? (
              <span />
            ) : confirmDelete ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                Delete this person?
                <button
                  type="button"
                  onClick={() =>
                    void close(
                      () => remove({ id: person.id }),
                      "That person could not be deleted. Try again.",
                    )
                  }
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
              <div className="-ml-3 flex flex-wrap gap-1">
                {person.archivedAt === null && (
                  <button
                    type="button"
                    onClick={() =>
                      void close(
                        () => archive({ id: person.id, archived: true }),
                        "That person could not be archived. Try again.",
                      )
                    }
                    className={quietButtonClass}
                  >
                    <ArchiveIcon aria-hidden className="size-4" />
                    Archive
                  </button>
                )}
                {person.removable && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className={`${quietButtonClass} hover:text-destructive`}
                  >
                    <Trash2Icon aria-hidden className="size-4" />
                    Delete
                  </button>
                )}
              </div>
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
          {person !== null && !person.removable && (
            <p className="text-xs text-ink-3">
              In a saved month, so not deleted: set an end date, or archive them to leave them out
              of every month not yet paid.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Someone out of the month's table: what they are paid and when, with the way back in. */
function WaitingRow({
  person,
  now,
  onEdit,
}: {
  person: Person;
  now: number;
  onEdit: () => void;
}) {
  const archive = useMutation(api.payroll.archivePerson);
  const { busy, error, run } = useAction();
  return (
    <DataRow>
      <DataRowHeader pinned>{person.name}</DataRowHeader>
      <DataCell>
        <PersonKind kind={person.kind} />
      </DataCell>
      <DataCell numeric>
        <Money
          minor={(person.payBasis === "net" ? person.monthlyNet : person.monthlyGross) ?? 0}
          currency={person.currency}
        />{" "}
        <span className="font-sans text-xs text-ink-2">{person.payBasis}</span>
      </DataCell>
      <DataCell className="font-num whitespace-nowrap text-ink-2">
        {person.startDate === null ? <Blank /> : dayLabel(person.startDate, now)}
      </DataCell>
      <DataCell className="font-num whitespace-nowrap text-ink-2">
        {person.endDate === null ? <Blank /> : dayLabel(person.endDate, now)}
      </DataCell>
      <DataCell actions>
        {person.archivedAt !== null && (
          <ActionButton
            busy={busy}
            icon={<ArchiveRestoreIcon aria-hidden className="size-4" />}
            className={rowActionClass}
            onClick={() =>
              void run(
                () => archive({ id: person.id, archived: false }),
                "That person could not be restored. Try again.",
              )
            }
          >
            Restore<span className="sr-only"> {person.name}</span>
          </ActionButton>
        )}
        <button type="button" onClick={onEdit} className={rowActionClass}>
          <PencilIcon aria-hidden className="size-4" />
          Edit<span className="sr-only"> {person.name}</span>
        </button>
        <Failure error={error} className="mt-1 whitespace-normal" />
      </DataCell>
    </DataRow>
  );
}

/** One collapsed group of people under the month's table, opened by its own button. */
function Group({
  label,
  caption,
  people,
  now,
  onEdit,
}: {
  label: string;
  caption: string;
  people: readonly Person[];
  now: number;
  onEdit: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (people.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={`${quietButtonClass} -ml-3`}
      >
        <ChevronDownIcon
          aria-hidden
          className={`size-4 text-ink-2 transition ${open ? "" : "-rotate-90"}`}
        />
        {label} ({people.length})
      </button>
      {open && (
        <DataTable caption={caption} className="min-w-[34rem]" boxClassName="mt-1">
          <DataHead>
            <DataHeader pinned>Name</DataHeader>
            <DataHeader>Kind</DataHeader>
            <DataHeader numeric>Pay a month</DataHeader>
            <DataHeader>Start</DataHeader>
            <DataHeader>End</DataHeader>
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {people.map((person) => (
              <WaitingRow
                key={person.id}
                person={person}
                now={now}
                onEdit={() => onEdit(person.id)}
              />
            ))}
          </DataBody>
        </DataTable>
      )}
    </div>
  );
}

/**
 * The people a company pays who are not in the month's table: not on payroll
 * that month (started later, or ended before it), and archived. Each group is
 * closed until opened; each person can be edited, and an archived one
 * restored.
 */
export function OtherPeople({
  monthName,
  waiting,
  archived,
  now,
  onEdit,
}: {
  monthName: string;
  waiting: readonly Person[];
  archived: readonly Person[];
  now: number;
  onEdit: (id: string) => void;
}) {
  if (waiting.length === 0 && archived.length === 0) return null;
  return (
    <div className="space-y-1">
      <Group
        label={`Not on payroll in ${monthName}`}
        caption={`Not on payroll in ${monthName}`}
        people={waiting}
        now={now}
        onEdit={onEdit}
      />
      <Group
        label="Archived"
        caption="Archived people"
        people={archived}
        now={now}
        onEdit={onEdit}
      />
    </div>
  );
}
