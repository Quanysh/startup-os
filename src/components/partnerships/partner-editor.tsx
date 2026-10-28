"use client";

import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  MAX_PARTNER_LINKS,
  PARTNER_STAGES,
  PARTNER_STAGE_LABELS,
  PARTNER_TYPES,
  PARTNER_TYPE_LABELS,
  type PartnerCard,
  type PartnerStage,
  type PartnerType,
  type PartnerValueKind,
} from "@convex/lib/partnerStages";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { messageOf } from "@/lib/errors";

/** What a save sends: only the fields that were changed. Null clears one. */
export type PartnerChange = {
  name?: string;
  type?: PartnerType;
  stage?: PartnerStage;
  owner?: string | null;
  contact?: string | null;
  contactRole?: string | null;
  value?: number | null;
  valueKind?: PartnerValueKind | null;
  nextStep?: string | null;
  nextStepOn?: string | null;
  notes?: string | null;
  links?: { label: string; url: string }[] | null;
};

type Draft = Partial<Record<
  | "name"
  | "type"
  | "stage"
  | "owner"
  | "contact"
  | "contactRole"
  | "value"
  | "valueKind"
  | "nextStep"
  | "nextStepOn"
  | "notes"
  | "links",
  string
>>;

const orNull = (text: string) => (text.trim() === "" ? null : text);

/** The links box: one per line, "Label | https://…". */
const linksText = (links: PartnerCard["links"]) =>
  links.map((link) => `${link.label} | ${link.url}`).join("\n");
function linksOf(text: string): { label: string; url: string }[] | null {
  const links = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const bar = line.lastIndexOf("|");
      return bar === -1
        ? { label: line, url: line }
        : { label: line.slice(0, bar).trim(), url: line.slice(bar + 1).trim() };
    });
  return links.length === 0 ? null : links;
}

/**
 * Edit one partner. What is typed is kept in a draft, field by field, and a
 * field with a draft never takes the server's value: a save landing elsewhere
 * (the owner's Claude changed it) must not replace words that are not saved.
 * A field with no draft shows the live value.
 */
export function PartnerEditor({
  partner,
  currency,
  onSave,
  onDelete,
  onClose,
  outcomes,
  below,
}: {
  /** The live partner, or null once it has left the board (or before it has arrived). */
  partner: PartnerCard | null;
  currency: string;
  onSave: (change: PartnerChange) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onClose: () => void;
  /** Shown under the form: the partner's outcomes timeline, mounted by the page (it reads Convex). */
  outcomes?: ReactNode;
  /** Shown under the form, after outcomes: linked contacts, mounted by the page. */
  below?: ReactNode;
}) {
  const [last, setLast] = useState(partner);
  if (partner !== null && partner !== last) setLast(partner);
  const shown = partner ?? last;

  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    name: useId(),
    type: useId(),
    stage: useId(),
    owner: useId(),
    contact: useId(),
    role: useId(),
    value: useId(),
    kind: useId(),
    nextStep: useId(),
    nextStepOn: useId(),
    notes: useId(),
    links: useId(),
  };
  if (shown === null) return null;
  const gone = partner === null;
  const edit = (patch: Draft) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const fields = {
    name: draft.name ?? shown.name,
    type: draft.type ?? shown.type,
    stage: draft.stage ?? shown.stage,
    owner: draft.owner ?? shown.owner ?? "",
    contact: draft.contact ?? shown.contact ?? "",
    contactRole: draft.contactRole ?? shown.contactRole ?? "",
    value: draft.value ?? (shown.value === null ? "" : String(shown.value)),
    valueKind: draft.valueKind ?? shown.valueKind ?? "",
    nextStep: draft.nextStep ?? shown.nextStep ?? "",
    nextStepOn: draft.nextStepOn ?? shown.nextStepOn ?? "",
    notes: draft.notes ?? shown.notes ?? "",
    links: draft.links ?? linksText(shown.links),
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (gone || busy) return;
    const changes: PartnerChange = {};
    if (draft.name !== undefined) {
      if (draft.name.trim() === "") return setError("A partner needs a name.");
      changes.name = draft.name;
    }
    if (draft.type !== undefined) changes.type = draft.type as PartnerType;
    if (draft.stage !== undefined) changes.stage = draft.stage as PartnerStage;
    if (draft.owner !== undefined) changes.owner = orNull(draft.owner);
    if (draft.contact !== undefined) changes.contact = orNull(draft.contact);
    if (draft.contactRole !== undefined) changes.contactRole = orNull(draft.contactRole);
    if (draft.value !== undefined || draft.valueKind !== undefined) {
      const text = fields.value.trim().replaceAll(",", "");
      const value = text === "" ? null : Number(text);
      if (value !== null && !Number.isFinite(value)) return setError("That value is not a number.");
      if (value !== null && fields.valueKind === "") {
        return setError("Say whether the value counts referrals or revenue.");
      }
      changes.value = value;
      changes.valueKind = value === null ? null : (fields.valueKind as PartnerValueKind);
    }
    if (draft.nextStep !== undefined) changes.nextStep = orNull(draft.nextStep);
    if (draft.nextStepOn !== undefined) changes.nextStepOn = orNull(draft.nextStepOn);
    if (draft.notes !== undefined) changes.notes = orNull(draft.notes);
    if (draft.links !== undefined) changes.links = linksOf(draft.links);
    if (Object.keys(changes).length === 0) return onClose();

    setBusy(true);
    setError(null);
    try {
      await onSave(changes);
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Partner</DialogTitle>
          <DialogDescription className="sr-only">
            Change this partner&apos;s details, stage, next step and notes.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={ids.name}>Company or organisation</Label>
            <input
              id={ids.name}
              value={fields.name}
              disabled={gone}
              onChange={(e) => edit({ name: e.target.value })}
              className={`${fieldClass} h-10`}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.type}>Type</Label>
              <select
                id={ids.type}
                value={fields.type}
                disabled={gone}
                onChange={(e) => edit({ type: e.target.value })}
                className={`${fieldClass} h-10`}
              >
                {PARTNER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {PARTNER_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.stage}>Stage</Label>
              <select
                id={ids.stage}
                value={fields.stage}
                disabled={gone}
                onChange={(e) => edit({ stage: e.target.value })}
                className={`${fieldClass} h-10`}
              >
                {PARTNER_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {PARTNER_STAGE_LABELS[stage]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.owner}>Owner</Label>
              <input
                id={ids.owner}
                value={fields.owner}
                disabled={gone}
                placeholder="Who on our side"
                onChange={(e) => edit({ owner: e.target.value })}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.contact}>Contact</Label>
              <input
                id={ids.contact}
                value={fields.contact}
                disabled={gone}
                placeholder="A name, no email or phone"
                onChange={(e) => edit({ contact: e.target.value })}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={ids.role}>Contact&apos;s role</Label>
              <input
                id={ids.role}
                value={fields.contactRole}
                disabled={gone}
                onChange={(e) => edit({ contactRole: e.target.value })}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.value}>Expected a month</Label>
              <input
                id={ids.value}
                inputMode="decimal"
                value={fields.value}
                disabled={gone}
                onChange={(e) => edit({ value: e.target.value })}
                className={`${fieldClass} h-10 font-num`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.kind}>It counts</Label>
              <select
                id={ids.kind}
                value={fields.valueKind}
                disabled={gone}
                onChange={(e) => edit({ valueKind: e.target.value })}
                className={`${fieldClass} h-10`}
              >
                <option value="">Nothing yet</option>
                <option value="referrals">Referrals</option>
                <option value="revenue">{`Revenue (${currency})`}</option>
              </select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor={ids.nextStep}>Next step</Label>
              <input
                id={ids.nextStep}
                value={fields.nextStep}
                disabled={gone}
                onChange={(e) => edit({ nextStep: e.target.value })}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.nextStepOn}>Due</Label>
              <input
                id={ids.nextStepOn}
                type="date"
                value={fields.nextStepOn}
                disabled={gone}
                onChange={(e) => edit({ nextStepOn: e.target.value })}
                className={`${fieldClass} h-10 font-num`}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.notes}>Notes</Label>
            <textarea
              id={ids.notes}
              value={fields.notes}
              disabled={gone}
              rows={3}
              onChange={(e) => edit({ notes: e.target.value })}
              className={`${fieldClass} py-2`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.links}>Links</Label>
            <textarea
              id={ids.links}
              value={fields.links}
              disabled={gone}
              rows={2}
              aria-describedby={`${ids.links}-hint`}
              onChange={(e) => edit({ links: e.target.value })}
              className={`${fieldClass} py-2`}
            />
            <p id={`${ids.links}-hint`} className="text-xs text-ink-3">
              {`One per line, like: Their site | https://example.com. Up to ${MAX_PARTNER_LINKS}.`}
            </p>
          </div>

          {gone && (
            <p role="alert" className="text-sm text-destructive">
              This partner left the board while you were editing, so it can no longer be saved. Copy
              anything you need before closing.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {gone ? (
              <span />
            ) : confirmDelete ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                Delete this partner?
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await onDelete();
                      onClose();
                    } catch (failure) {
                      setError(messageOf(failure, "That could not be deleted. Try again."));
                      setConfirmDelete(false);
                    }
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
                {gone ? "Close without saving" : "Cancel"}
              </button>
              <button type="submit" disabled={busy || gone} className={primaryButtonClass}>
                {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </form>
        {/* What came of the bots' plays on this partner (the page's OutcomesTimeline). */}
        {outcomes !== undefined && <div className="mt-6 border-t border-line pt-4">{outcomes}</div>}
        {below !== undefined && <div className="mt-6 border-t border-line pt-4">{below}</div>}
      </DialogContent>
    </Dialog>
  );
}
