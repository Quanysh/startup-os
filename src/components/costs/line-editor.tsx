"use client";

import { useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  BUCKET_LABELS,
  CADENCE_LABELS,
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  COST_BUCKETS,
  COST_CADENCES,
  COST_CATEGORIES,
  NO_ACCOUNT_NUMBERS,
  defaultBucket,
  isMonth,
  looksLikeAccountNumber,
  type CostBucket,
  type CostCadence,
  type CostCategory,
} from "@convex/lib/costs";
import { offeredCurrencies, startingCurrencyOf } from "@convex/lib/customerShape";
import {
  MAX_COST_NAME_LENGTH,
  MAX_COST_NOTE_LENGTH,
  MAX_COST_PAID_BY_LENGTH,
} from "@convex/lib/limits";
import type { Currency } from "@convex/lib/metricRegistry";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { ActionButton, Failure, useAction } from "@/components/payroll/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { CompanyId } from "@/lib/company";
import { moneyInput, parseMoney } from "@/lib/payroll/input";
import { CURRENCY_NAMES, QuickAdd, type Line } from "./shared";

const AMOUNT_HINT: Record<CostCadence, string> = {
  monthly: "What it costs each month.",
  quarterly: "What each quarter's bill is. A third of it counts each month.",
  yearly: "What the year's bill is. A twelfth of it counts each month.",
  once: "The whole amount, paid once.",
};

/**
 * Add a cost line, or edit one. The fields are read once, when the editor
 * opens: a live update arriving while it is open never replaces what was
 * typed. A quick-add chip fills the name and the category and nothing else:
 * no amount is ever suggested, and nothing exists until it is saved.
 */
export function LineEditor({
  company,
  line,
  preset,
  month,
  onClose,
}: {
  company: CompanyId;
  /** The line being edited, or null to add one. */
  line: Line | null;
  /** A quick-add chip's name and category, for a new line. */
  preset?: { name: string; category: CostCategory };
  /** This month, "YYYY-MM": where a new line starts unless another is said. */
  month: string;
  onClose: () => void;
}) {
  const add = useMutation(api.costs.add);
  const update = useMutation(api.costs.update);

  const [name, setName] = useState(line?.name ?? preset?.name ?? "");
  const [category, setCategory] = useState<CostCategory>(line?.category ?? preset?.category ?? "software");
  const [amount, setAmount] = useState(line === null ? "" : moneyInput(line.amount));
  const [currency, setCurrency] = useState<Currency>(line?.currency ?? startingCurrencyOf(company));
  const [cadence, setCadence] = useState<CostCadence>(line?.cadence ?? "monthly");
  const [startsOn, setStartsOn] = useState(line?.startsOn ?? month);
  const [endsOn, setEndsOn] = useState(line?.endsOn ?? "");
  const [variable, setVariable] = useState(line?.variable ?? false);
  // What it counts as in unit economics: null follows the category.
  const [bucket, setBucket] = useState<CostBucket | null>(line?.bucket ?? null);
  const [paidBy, setPaidBy] = useState(line?.paidBy ?? "");
  const [note, setNote] = useState(line?.note ?? "");
  const { busy, error, setError, run } = useAction();
  const id = useId();
  const once = cadence === "once";

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    // The server decides; these only save a round trip, in its own words.
    if (name.trim() === "") return setError("A cost needs a name.");
    if (name.trim().length > MAX_COST_NAME_LENGTH) {
      return setError(`That name is too long (${MAX_COST_NAME_LENGTH} characters at most).`);
    }
    const minor = parseMoney(amount);
    if (minor === null || minor <= 0) return setError("The amount must be a whole amount above zero.");
    if (!isMonth(startsOn)) return setError("The start is not a month.");
    if (!once && endsOn !== "" && !isMonth(endsOn)) return setError("The end is not a month.");
    if (!once && endsOn !== "" && endsOn < startsOn) return setError("The end is before the start.");
    if ([name, paidBy, note].some(looksLikeAccountNumber)) return setError(NO_ACCOUNT_NUMBERS);
    const end = once || endsOn === "" ? null : endsOn;
    const fields = { name, category, amount: minor, currency, cadence, startsOn, variable };
    // Sent when it says something new: a choice for a new line, a change for an edit.
    const countsAs = bucket !== (line?.bucket ?? null) ? { bucket } : null;
    const saved = await run(() =>
      line === null
        ? add({
            company,
            ...fields,
            ...(bucket !== null ? { bucket } : null),
            ...(end !== null ? { endsOn: end } : null),
            ...(paidBy.trim() !== "" ? { paidBy } : null),
            ...(note.trim() !== "" ? { note } : null),
          })
        : update({
            id: line.id,
            ...fields,
            ...countsAs,
            endsOn: end,
            paidBy: paidBy.trim() === "" ? null : paidBy,
            note: note.trim() === "" ? null : note,
          }),
    );
    if (saved) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">{line === null ? "Add a cost" : "Edit cost"}</DialogTitle>
          <DialogDescription className="sr-only">
            What is paid for, how much, how often and from when. No card or account numbers.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4" noValidate>
          {line === null && (
            <div className="space-y-1.5">
              <p className="text-xs text-ink-2">
                Start from a common line. It fills the name and the category only.
              </p>
              <QuickAdd
                onPick={(picked) => {
                  setName(picked.name);
                  setCategory(picked.category);
                }}
              />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <input
                id={`${id}-name`}
                autoComplete="off"
                maxLength={MAX_COST_NAME_LENGTH * 2}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-category`}>Category</Label>
              <select
                id={`${id}-category`}
                value={category}
                onChange={(e) => setCategory(e.target.value as CostCategory)}
                className={`${fieldClass} h-10`}
              >
                {COST_CATEGORIES.map((one) => (
                  <option key={one} value={one}>
                    {CATEGORY_LABELS[one]}: {CATEGORY_HINTS[one]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${id}-bucket`}>Counts as</Label>
              <select
                id={`${id}-bucket`}
                aria-describedby={`${id}-bucket-hint`}
                value={bucket ?? ""}
                onChange={(e) => setBucket(e.target.value === "" ? null : (e.target.value as CostBucket))}
                className={`${fieldClass} h-10`}
              >
                <option value="">As its category: {BUCKET_LABELS[defaultBucket(category)]}</option>
                {COST_BUCKETS.map((one) => (
                  <option key={one} value={one}>
                    {BUCKET_LABELS[one]}
                  </option>
                ))}
              </select>
              <p id={`${id}-bucket-hint`} className="text-xs text-ink-3">
                For unit economics on Finance: serving customers is in the gross margin, sales and marketing in
                what a customer costs to win.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-amount`}>Amount</Label>
              <input
                id={`${id}-amount`}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={`${id}-amount-hint`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${fieldClass} h-10 text-right font-num`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-currency`}>Currency</Label>
              <select
                id={`${id}-currency`}
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                className={`${fieldClass} h-10`}
              >
                {offeredCurrencies().map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </div>
            <p id={`${id}-amount-hint`} className="-mt-2 text-xs text-ink-3 sm:col-span-2">
              {AMOUNT_HINT[cadence]} In {CURRENCY_NAMES[currency]}.
            </p>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${id}-cadence`}>How often</Label>
              <select
                id={`${id}-cadence`}
                value={cadence}
                onChange={(e) => setCadence(e.target.value as CostCadence)}
                className={`${fieldClass} h-10`}
              >
                {COST_CADENCES.map((one) => (
                  <option key={one} value={one}>
                    {CADENCE_LABELS[one]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-start`}>{once ? "Month" : "Starts"}</Label>
              <input
                id={`${id}-start`}
                type="month"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
            {!once && (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-end`}>Ends (optional)</Label>
                <input
                  id={`${id}-end`}
                  type="month"
                  value={endsOn}
                  onChange={(e) => setEndsOn(e.target.value)}
                  className={`${fieldClass} h-10`}
                />
              </div>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={variable}
              onChange={(e) => setVariable(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-brand"
            />
            <span>
              This is an estimate
              <span className="block text-xs text-ink-2">
                It changes month to month, like cloud usage. Shown with “≈”.
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-paid`}>Paid by (optional)</Label>
            <input
              id={`${id}-paid`}
              autoComplete="off"
              maxLength={MAX_COST_PAID_BY_LENGTH * 2}
              placeholder="Mercury card"
              value={paidBy}
              onChange={(e) => setPaidBy(e.target.value)}
              className={`${fieldClass} h-10`}
            />
            <p className="text-xs text-ink-3">In words. Never a card or account number.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-note`}>Note (optional)</Label>
            <textarea
              id={`${id}-note`}
              rows={2}
              maxLength={MAX_COST_NOTE_LENGTH * 2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={`${fieldClass} py-2`}
            />
          </div>

          <Failure error={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className={quietButtonClass}>
              Cancel
            </button>
            <ActionButton type="submit" busy={busy} className={primaryButtonClass}>
              {line === null ? "Add cost" : "Save"}
            </ActionButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
