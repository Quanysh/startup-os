"use client";

import { useMutation } from "convex/react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  CUSTOMER_STATUS_LABELS,
  MARKET_LABELS,
  type CustomerRow,
} from "@convex/lib/customerShape";
import { MAX_NOTES_LENGTH } from "@convex/lib/limits";
import { fieldClass, primaryButtonClass } from "@/components/panel";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Health } from "@/lib/customers/health";
import {
  baaText,
  dateText,
  feeText,
  owedText,
  usageText,
} from "@/lib/customers/view";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { HealthBadge } from "./health-badge";
import { OutcomesTimeline } from "@/components/outcomes/outcomes-timeline";

type Draft = { note?: string; nextTouch?: string };
type SaveState = { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * One clinic: why its health reads as it does, what the register says about
 * it, and the owner's own two fields.
 *
 * The note and the next touch are the only things edited here; everything
 * else belongs to the client register. Unsaved text always wins over what the
 * server sends: `draft` holds what was typed, a field with no draft shows the
 * saved value live, and a push landing while the drawer is open never
 * replaces words that are not saved yet.
 */
export function CustomerDrawer({
  clinic,
  health,
  now,
  onClose,
}: {
  clinic: CustomerRow;
  health: Health;
  now: number;
  onClose: () => void;
}) {
  const save = useMutation(api.customers.setOwnerFields);
  const [draft, setDraft] = useState<Draft>({});
  const [state, setState] = useState<SaveState | null>(null);
  const ids = { note: useId(), nextTouch: useId() };

  const note = draft.note ?? clinic.note ?? "";
  const nextTouch = draft.nextTouch ?? clinic.nextTouch ?? "";
  const dirty = draft.note !== undefined || draft.nextTouch !== undefined;
  const saving = state?.kind === "saving";
  const tooLong = note.trim().length > MAX_NOTES_LENGTH;

  const edit = (patch: Draft) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (!saving) setState(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !dirty || tooLong) return;
    const submitted = draft;
    setState({ kind: "saving" });
    try {
      // Only what was typed is sent: a field left alone is not overwritten
      // with what this drawer happened to be showing.
      await save({
        id: clinic.id,
        ...(submitted.note !== undefined
          ? { note: submitted.note.trim() === "" ? null : submitted.note }
          : null),
        ...(submitted.nextTouch !== undefined
          ? { nextTouch: submitted.nextTouch === "" ? null : submitted.nextTouch }
          : null),
      });
      // Drop only what was saved; anything typed while the save was in
      // flight is still a draft.
      setDraft((current) => ({
        ...(current.note !== submitted.note ? { note: current.note } : null),
        ...(current.nextTouch !== submitted.nextTouch ? { nextTouch: current.nextTouch } : null),
      }));
      setState({ kind: "saved" });
    } catch (failure) {
      setState({ kind: "error", message: messageOf(failure) });
    }
  };

  const facts: [string, string][] = [
    ["Market", MARKET_LABELS[clinic.market]],
    ["Status in the register", CUSTOMER_STATUS_LABELS[clinic.status]],
    ["Monthly fee", feeText(clinic)],
    ["Last payment", dateText(clinic.lastPaymentDate, now)],
    ["Amount owed", owedText(clinic)],
    ["Last use", usageText(clinic, now)],
    ["Contract date", dateText(clinic.contractDate, now)],
    ["BAA date", baaText(clinic, now)],
  ];

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto bg-panel p-6 sm:max-w-md">
        <SheetHeader className="p-0 pr-8">
          <SheetTitle className="text-lg text-ink">{clinic.name}</SheetTitle>
          <SheetDescription className="sr-only">
            This clinic&apos;s health and what the client register says about it, with your own
            note and next touch.
          </SheetDescription>
        </SheetHeader>

        <section aria-label="Health" className="mt-4">
          <HealthBadge level={health.level} className="font-medium" />
          {health.level === "not_assessed" ? (
            <p className="mt-2 text-sm text-ink-2">{health.why}</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {health.reasons.map((reason) => (
                <li key={reason.signal} className="flex items-start gap-2 text-sm text-ink-2">
                  <HealthBadge level={reason.level} className="w-24 shrink-0 text-xs" />
                  <span>{reason.text}</span>
                </li>
              ))}
            </ul>
          )}
          {clinic.archived && (
            <p className="mt-2 text-sm text-ink-2">
              The last push of the register did not carry this clinic. Its note is kept.
            </p>
          )}
        </section>

        <section aria-label="From the client register" className="mt-6">
          <h3 className="text-sm font-medium text-ink">From the client register</h3>
          <dl className="mt-2 divide-y divide-line">
            {facts.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <dt className="text-ink-2">{label}</dt>
                <dd className="text-right text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* What came of the bots' plays on this clinic: shown to whoever holds Outcomes. */}
        <div className="mt-6">
          <OutcomesTimeline kind="customer" id={clinic.id} />
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4" aria-label="Your notes">
          <h3 className="text-sm font-medium text-ink">Yours</h3>
          <div className="space-y-1.5">
            <Label htmlFor={ids.nextTouch}>Next touch</Label>
            <input
              id={ids.nextTouch}
              type="date"
              value={nextTouch}
              onChange={(e) => edit({ nextTouch: e.target.value })}
              className={`${fieldClass} h-10`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.note}>Note</Label>
            <textarea
              id={ids.note}
              value={note}
              onChange={(e) => edit({ note: e.target.value })}
              rows={5}
              aria-invalid={tooLong || undefined}
              className={`${fieldClass} py-2`}
            />
            <p className="text-xs text-ink-3">
              A push of the register never changes the note or the next touch.
            </p>
          </div>

          {tooLong && (
            <p role="alert" className="text-sm text-destructive">
              That note is too long ({MAX_NOTES_LENGTH} characters at most).
            </p>
          )}
          {state?.kind === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}

          <div className="flex items-center gap-3">
            {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
            <button
              type="submit"
              aria-disabled={saving || !dirty || tooLong}
              className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
            >
              {saving && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
              Save
            </button>
            <p role="status" className="text-sm text-ink-2">
              {state?.kind === "saved" && !dirty && (
                <span className="inline-flex items-center gap-1">
                  <CheckIcon aria-hidden className="size-4 text-good" />
                  Saved
                </span>
              )}
              {dirty && !saving && state?.kind !== "error" && "Not saved yet"}
            </p>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
