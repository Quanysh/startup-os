"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { Panel, fieldClass, primaryButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

type Lists = { investor: string; customer: string };
const lines = (text: string) => text.split("\n");

/**
 * The two domain lists that group mail on the Today page. What is typed is a
 * draft that always wins: a field adopts the server's list only while it has
 * not been touched, so a live update never discards typing.
 */
export function DomainLists() {
  const settings = useQuery(api.workTools.settings);
  const setDomains = useMutation(api.workTools.setDomains);
  const investorId = useId();
  const customerId = useId();
  const hintId = useId();

  const [draft, setDraft] = useState<Partial<Lists>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (settings === undefined) {
    return (
      <Panel aria-label="Domain lists">
        <Skeleton data-testid="domains-loading" className="h-40 rounded-inner" />
      </Panel>
    );
  }

  const shown: Lists = {
    investor: draft.investor ?? settings.investorDomains.join("\n"),
    customer: draft.customer ?? settings.customerDomains.join("\n"),
  };
  const edit = (field: keyof Lists, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setError(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const sent = shown;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await setDomains({ investor: lines(sent.investor), customer: lines(sent.customer) });
      // Let go of a draft only if nothing more was typed while the save ran;
      // the field then shows the list as the server tidied it.
      setDraft((current) => ({
        investor: current.investor === sent.investor ? undefined : current.investor,
        customer: current.customer === sent.customer ? undefined : current.customer,
      }));
      setSaved(true);
    } catch (failure) {
      setError(messageOf(failure, "The lists could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const field = (name: keyof Lists, id: string, label: string) => (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <textarea
        id={id}
        rows={5}
        spellCheck={false}
        autoCapitalize="none"
        aria-describedby={hintId}
        value={shown[name]}
        onChange={(e) => edit(name, e.target.value)}
        placeholder="example.com"
        className={cn(fieldClass, "py-2 font-mono text-[13px]")}
      />
    </div>
  );

  return (
    <Panel aria-labelledby="domain-lists">
      <h2 id="domain-lists" className="text-base">
        Who is who
      </h2>
      <p id={hintId} className="mt-1 max-w-2xl text-sm text-ink-2">
        <span>One domain per line.</span>{" "}
        <span>
          Mail from these domains is grouped on the Today page. Everything else is
          &quot;Other&quot;.
        </span>
      </p>
      <form onSubmit={save} className="mt-4 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {field("investor", investorId, "Investor domains")}
          {field("customer", customerId, "Customer domains")}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* aria-disabled, not disabled: a natively disabled button drops focus. */}
          <button
            type="submit"
            aria-disabled={busy}
            className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
          >
            Save
          </button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p role="status" className="text-sm text-ink-2">
              {saved && "Saved."}
            </p>
          )}
        </div>
      </form>
    </Panel>
  );
}
