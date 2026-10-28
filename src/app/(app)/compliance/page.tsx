"use client";

import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { OBLIGATION_CATEGORIES, type ObligationRow } from "@convex/lib/obligationShape";
import { useCompany } from "@/components/company-provider";
import { AgreementsTab } from "@/components/compliance/agreements-tab";
import { AnswerBankTab } from "@/components/compliance/answer-bank-tab";
import { EvidenceTab } from "@/components/compliance/evidence-tab";
import { ObligationList } from "@/components/compliance/obligation-list";
import { QuestionnairesTab } from "@/components/compliance/questionnaires-tab";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, categoryServes, categoryServesAny } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { lastChange } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "obligations", label: "Dates" },
  { id: "questionnaires", label: "Questionnaires" },
  { id: "answers", label: "Answer bank" },
  { id: "agreements", label: "Vendor agreements" },
  { id: "evidence", label: "Evidence" },
] as const;
type Tab = (typeof TABS)[number]["id"];
const isTab = (value: string | null | undefined): value is Tab => TABS.some((t) => t.id === value);

type Added = { kind: "adding" } | { kind: "added"; count: number } | { kind: "error"; message: string };

/**
 * /compliance: what has to be done, by when, and where the proof is. It
 * tracks dates and evidence. Nothing on it says the company is compliant with
 * anything, and no date appears that nobody entered: an item without a
 * confirmed date reads as unconfirmed.
 */
export default function CompliancePage() {
  const params = useSearchParams();
  const asked = params?.get("tab");
  const [tab, setTab] = useState<Tab>(isTab(asked) ? asked : "obligations");
  const now = useNow();
  const company = useCompany();
  const all = useQuery(api.obligations.list);
  // Company and tax dates and contracts are in both views; the rest follow their company.
  const rows = all?.filter((o) => categoryServes(company, o.category));

  const choose = (next: Tab) => {
    setTab(next);
    // The tab lives in the address, so a link leads to it. No navigation: the page stays.
    const url = new URL(window.location.href);
    if (next === "obligations") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compliance"
        purpose="What has to be done, by when, and where the proof is. This page tracks dates and evidence. It does not say whether the company meets any standard."
        // Typed in here: when an item in view last changed. The other tabs say their own.
        aside={
          tab === "obligations" ? (
            <TypedFreshness label="Compliance items" at={rows === undefined ? undefined : lastChange(rows)} />
          ) : undefined
        }
      />
      <div role="tablist" aria-label="Compliance records" className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-panel p-1 shadow-soft-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => choose(t.id)}
            className={cn(
              "h-9 shrink-0 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              tab === t.id ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
        {tab === "obligations" ? (
          <ObligationsTab rows={rows} />
        ) : now === null ? (
          <Skeleton aria-busy className="h-64 w-full rounded-card" />
        ) : tab === "questionnaires" ? (
          <QuestionnairesTab today={localIsoDate(now)} now={now} />
        ) : tab === "answers" ? (
          <AnswerBankTab today={localIsoDate(now)} now={now} />
        ) : tab === "agreements" ? (
          <AgreementsTab today={localIsoDate(now)} now={now} />
        ) : (
          <EvidenceTab today={localIsoDate(now)} now={now} />
        )}
      </div>
    </div>
  );
}

function ObligationsTab({ rows }: { rows: ObligationRow[] | undefined }) {
  const company = useCompany();
  const addStarter = useMutation(api.starterChecklist.add);
  const now = useNow();
  const [added, setAdded] = useState<Added | null>(null);

  const adding = added?.kind === "adding";
  const add = async () => {
    if (adding || now === null) return;
    setAdded({ kind: "adding" });
    try {
      const result = await addStarter({ today: localIsoDate(now) });
      setAdded({ kind: "added", count: result.added });
    } catch (failure) {
      setAdded({ kind: "error", message: messageOf(failure, "The checklist could not be added. Try again.") });
    }
  };

  const starter = (
    <div className="space-y-2">
      {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
      <button
        type="button"
        onClick={add}
        aria-disabled={adding}
        className={cn(quietButtonClass, "bg-surface text-ink aria-disabled:opacity-60")}
      >
        Add the starter checklist
      </button>
      <p role="status" className="text-sm text-ink-2">
        {added?.kind === "added" &&
          (added.count === 0
            ? "Every starter item is already here."
            : added.count === 1
              ? "Added 1 item."
              : `Added ${added.count} items.`)}
      </p>
      {added?.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {added.message}
        </p>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {rows === undefined || now === null ? (
        <div className="space-y-6" aria-busy>
          <Skeleton className="h-28 w-full rounded-card" />
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
      ) : (
        <>
          {rows.length === 0 && (
            <section className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
              <h2 className="text-base">Nothing here yet</h2>
              <p className="mt-2 mb-4 max-w-2xl text-sm text-ink-2">
                Add items one at a time below, or start from a checklist of questions to answer.
                Its items come without dates, except one the law fixes, and that one stays
                unconfirmed until you say it applies.
              </p>
              {starter}
            </section>
          )}

          <ObligationList
            rows={rows}
            today={localIsoDate(now)}
            now={now}
            categories={OBLIGATION_CATEGORIES.filter((c) => categoryServes(company, c.id))}
          />

          <IsoPack />

          {rows.length > 0 && (
            <section aria-label="Starter checklist" className="space-y-2">
              <p className="max-w-2xl text-sm text-ink-2">
                The starter checklist adds only the items that are not here already, and never
                changes one you have edited.
              </p>
              {starter}
            </section>
          )}
        </>
      )}
    </div>
  );
}

type IsoAdded =
  | { kind: "adding" }
  | { kind: "added"; items: number; controls: number }
  | { kind: "error"; message: string };

/**
 * Globex's ISO 27001 pack: the ISMS's recurring duties and open findings
 * here, its applicable controls on the Evidence tab. Offered only to someone
 * on Globex looking at Globex; the server refuses anyone else.
 */
function IsoPack() {
  const company = useCompany();
  const { companies } = useViewer();
  const addPack = useMutation(api.isoPack.add);
  const [added, setAdded] = useState<IsoAdded | null>(null);
  if (!categoryServes(company, "iso27001") || !categoryServesAny(companies, "iso27001")) return null;

  const adding = added?.kind === "adding";
  const add = async () => {
    if (adding) return;
    setAdded({ kind: "adding" });
    try {
      const result = await addPack({});
      setAdded({ kind: "added", ...result });
    } catch (failure) {
      setAdded({ kind: "error", message: messageOf(failure, "The ISO 27001 calendar could not be added. Try again.") });
    }
  };

  return (
    <section aria-label="ISO 27001 calendar" className="space-y-2">
      <p className="max-w-2xl text-sm text-ink-2">
        {COMPANIES.kz.name}&apos;s ISO 27001 calendar: the duties its security policies repeat, the findings
        from its audits, and on the Evidence tab the controls it applies. Dates come unconfirmed;
        nothing already here is changed.
      </p>
      <button
        type="button"
        onClick={add}
        aria-disabled={adding}
        className={cn(quietButtonClass, "bg-surface text-ink aria-disabled:opacity-60")}
      >
        Add the ISO 27001 calendar
      </button>
      <p role="status" className="text-sm text-ink-2">
        {added?.kind === "added" &&
          (added.items === 0 && added.controls === 0
            ? "The ISO 27001 calendar is already here."
            : `Added ${added.items} ${added.items === 1 ? "item" : "items"} and ${added.controls} ${added.controls === 1 ? "control" : "controls"}.`)}
      </p>
      {added?.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {added.message}
        </p>
      )}
    </section>
  );
}
