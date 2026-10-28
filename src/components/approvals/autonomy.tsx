"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { MAX_DISMISS_REASON_LENGTH } from "@convex/lib/agents";
import type { Id } from "@convex/_generated/dataModel";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

// Earned autonomy on /approvals and the Bots tab (convex/trust.ts): the offer
// after ten clean approvals in a row, the grants, and flagging what was
// approved without the owner's click (listed on /approvals' "Decided"). The
// never-list is the server's: nothing here decides what may be offered.

const small = "h-9 px-3";
const code = "rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-ink";

/** One button's call with its error kept beside it. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(messageOf(failure, "That could not be done. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** "Let Growth do `deal_next_step` without approval?" with Yes / Not yet, one banner an offer. */
export function AutonomyOffers() {
  const offers = useQuery(api.trust.offers, {});
  const grant = useMutation(api.trust.grant);
  const notYet = useMutation(api.trust.notYet);
  const { busy, error, run } = useRun();
  if (offers === undefined || offers.length === 0) return null;
  return (
    <div className="space-y-2" aria-label="Autonomy offers">
      {offers.map((offer) => (
        <div
          key={`${offer.proposer}:${offer.kind}`}
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-inner bg-info-soft px-4 py-3 text-sm text-info-ink"
        >
          <p className="mr-auto min-w-0 [overflow-wrap:anywhere]">
            Let {offer.name} do <code className={code}>{offer.kind}</code> without approval?{" "}
            <span className="text-xs">
              {offer.streak} approved in a row with no edit. Each one is still logged below, and you can take it back.
            </span>
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => grant({ proposer: offer.proposer, kind: offer.kind }))}
            className={cn(primaryButtonClass, small)}
          >
            Yes
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => notYet({ proposer: offer.proposer, kind: offer.kind }))}
            className={cn(quietButtonClass, small, "bg-panel text-ink")}
          >
            Not yet
          </button>
        </div>
      ))}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

type Grant = {
  proposer: string;
  name: string;
  kind: string;
  /** A bot's grant waiting on write on the kind's area: it auto-approves nothing until then. */
  paused?: { area: string; name: string } | null;
};

/** Grants in force, each revoked in one click. */
function GrantList({ grants, named }: { grants: readonly Grant[]; named: boolean }) {
  const revoke = useMutation(api.trust.revoke);
  const { busy, error, run } = useRun();
  if (grants.length === 0) return null;
  return (
    <div>
      <ul className="flex flex-wrap gap-2" aria-label="Approved without asking">
        {grants.map((g) => (
          <li
            key={`${g.proposer}:${g.kind}`}
            className="flex items-center gap-2 rounded-full border border-line py-0.5 pr-1 pl-3 text-xs text-ink-2"
          >
            <span>
              {named ? `${g.name}: ` : "Without asking: "}
              <code className={code}>{g.kind}</code>
              {g.paused != null && (
                <span className="ml-1 text-warning-ink">{`paused: needs write on ${g.paused.name}`}</span>
              )}
            </span>
            <button
              type="button"
              disabled={busy}
              aria-label={`Revoke ${g.name}: ${g.kind}`}
              onClick={() => void run(() => revoke({ proposer: g.proposer, kind: g.kind as never }))}
              className={cn(quietButtonClass, "h-7 px-2 text-xs")}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** On a bot's card on Agents › Bots: what it may do without the owner's approval. */
export function BotGrants({ botId }: { botId: string }) {
  const grants = useQuery(api.trust.grants, {});
  if (grants === undefined) return null;
  return <GrantList grants={grants.filter((g) => g.proposer === botId)} named={false} />;
}

/** On /approvals' "Decided": every grant in force, each revoked in one click. Nothing while there is none. */
export function Grants() {
  const grants = useQuery(api.trust.grants, {});
  if (grants === undefined || grants.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-ink-2">Approved without asking</p>
      <GrantList grants={grants} named />
    </div>
  );
}

/**
 * Flag an item approved without a click: that grant is revoked, the streak
 * starts again, and the reason (optional) reaches the proposer. What was
 * done stays done.
 */
export function FlagAuto({ id, name }: { id: string; name: string }) {
  const flag = useMutation(api.trust.flag);
  const { busy, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const ids = useId();
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={cn(quietButtonClass, small, "mt-2")}>
        Flag and revoke
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      aria-label="Flag"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await flag({ id: id as Id<"proposals">, ...(reason.trim() === "" ? null : { reason: reason.trim() }) });
          setOpen(false);
        });
      }}
    >
      <label htmlFor={ids} className="block min-w-0 flex-1 text-xs font-medium text-ink-2">
        Why? (optional: {name} reads it)
        <input
          id={ids}
          value={reason}
          maxLength={MAX_DISMISS_REASON_LENGTH}
          onChange={(event) => setReason(event.target.value)}
          className={cn(fieldClass, "mt-1 h-9")}
        />
      </label>
      <button type="submit" disabled={busy} className={cn(primaryButtonClass, small)}>
        Flag and revoke
      </button>
      <button type="button" onClick={() => setOpen(false)} className={cn(quietButtonClass, small, "bg-panel text-ink")}>
        Cancel
      </button>
      {error !== null && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
