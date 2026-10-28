"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { ArrowLeftIcon, CheckIcon, Loader2Icon, PencilIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { DealIntel, IntelEdit } from "@convex/lib/dealIntel";
import { UNMAPPED } from "@convex/lib/pipelineStages";
import { GatedLink } from "@/components/gated-link";
import { CardEditor } from "@/components/pipeline/card-editor";
import { Panel, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { PRIORITY_LOOK, STAGE_LOOK } from "@/components/sales/deal-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { formatPeriod, formatValue } from "@/lib/format";
import { researchedLabel } from "@/lib/pipeline/intel-view";
import { DEAL_COLUMNS, stageTitle } from "@/lib/pipeline/stages";
import { boardRows, lastActivityLabel, type TableDeal } from "@/lib/pipeline/table-view";
import { IntelEditor } from "./intel-editor";
import {
  CompetitorList,
  FitMeter,
  PeopleList,
  PointLists,
  Section,
  SignalsTimeline,
  SourceLinks,
  TechAndBilling,
  hasPoints,
  hasTechAndBilling,
} from "./intel-sections";
import { LinkedContacts } from "@/components/contacts/linked-contacts";
import { OutcomesTimeline } from "@/components/outcomes/outcomes-timeline";

type IntelArgs = Omit<FunctionArgs<typeof api.dealIntel.update>, "dealId">;

const WORDS = {
  noun: "deal",
  title: "Deal",
  nameLabel: "Company",
  blankName: "A deal needs a company name.",
  amountLabel: "Monthly fee (USD)",
};

/**
 * One US deal's page (`/sales/deals/[id]`): what it is on the board and what
 * research found about it (`dealIntel.get`). The deal is read from the same
 * `deals.board` the table reads, so the two never disagree; its editor is
 * "Edit details", and "Edit intelligence" edits the research.
 *
 * Startup's deals only: someone not on Startup is told so and nothing is asked
 * for. An id that is no deal on the US board (archived, deleted, or not a
 * deal) is said in one line, never a guess.
 */
export function DealPage({ dealId }: { dealId: string }) {
  const { companies } = useViewer();
  const onStartup = companies.includes("us");
  const board = useQuery(api.deals.board, onStartup ? { market: "us" } : "skip");
  const intel = useQuery(api.dealIntel.get, onStartup ? { dealId } : "skip");
  // Whether a won deal is on Customers: a line in the header, never a wait.
  const customers = useQuery(api.customers.ofDeal, onStartup ? { dealId } : "skip");
  const now = useNow();
  const router = useRouter();
  const update = useMutation(api.deals.update);
  const remove = useMutation(api.deals.remove);
  const updateIntel = useMutation(api.dealIntel.update);
  const [editing, setEditing] = useState<"details" | "intel" | null>(null);

  if (!onStartup) {
    return (
      <Quiet title={`Nothing here for ${COMPANIES.kz.name}`}>
        A deal&apos;s page is kept for {COMPANIES.us.name}&apos;s US deals only.
      </Quiet>
    );
  }
  if (board === undefined || intel === undefined) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  const deal = boardRows(board).find((card) => card.id === dealId) ?? null;
  if (deal === null) {
    return (
      <Quiet title="This deal is not on the board">
        It may have been archived or deleted. Archived deals are listed under the US table.
      </Quiet>
    );
  }

  const id = deal.id as Id<"deals">;
  return (
    <div className="space-y-6">
      <DealHeader
        deal={deal}
        intel={intel}
        onCustomers={customers?.onCustomers === true}
        onEditDetails={() => setEditing("details")}
        onEditIntel={() => setEditing("intel")}
      />
      {intel === null ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-surface px-5 py-4 text-sm text-ink-2">
          No research on this deal yet.
          <button
            type="button"
            onClick={() => setEditing("intel")}
            className="rounded font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Add intelligence
          </button>
        </p>
      ) : (
        <Intelligence
          deal={deal}
          intel={intel}
          onNextStep={(nextStep) => update({ id, nextStep })}
        />
      )}
      <DealFacts deal={deal} now={now} />
      <OutcomesTimeline kind="deal" id={deal.id} />
      <LinkedContacts company="us" type="deal" recordId={deal.id} />

      {editing === "details" && (
        <CardEditor
          card={deal}
          words={WORDS}
          columns={DEAL_COLUMNS}
          currency="USD"
          mirrorNamed={null}
          withDetails
          onSave={(edit) => update({ id, ...edit })}
          onDelete={async () => {
            await remove({ id });
            router.replace("/sales");
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === "intel" && (
        <IntelEditor
          intel={intel}
          // The edit's lists are read-only; the function's arguments are the same shape.
          onSave={(edit: IntelEdit) => updateIntel({ dealId: id, ...(edit as IntelArgs) })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Quiet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <BackLink />
      <Panel>
        <h1 className="text-xl">{title}</h1>
        <p className="mt-2 max-w-xl text-sm text-ink-2">{children}</p>
      </Panel>
    </section>
  );
}

function BackLink() {
  return (
    <Link
      href="/sales"
      className="inline-flex items-center gap-1.5 rounded text-sm text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon aria-hidden className="size-4" />
      Sales
    </Link>
  );
}

/** The deal's name, where it stands, what it is, and its fit; the two editors. */
function DealHeader({
  deal,
  intel,
  onCustomers,
  onEditDetails,
  onEditIntel,
}: {
  deal: TableDeal;
  intel: DealIntel | null;
  /** Won, and a clinic on Customers is linked to it (convex/lib/wonCustomers.ts). */
  onCustomers: boolean;
  onEditDetails: () => void;
  onEditIntel: () => void;
}) {
  const stage = STAGE_LOOK[deal.stage] ?? STAGE_LOOK[UNMAPPED]!;
  const priority = deal.priority == null ? null : PRIORITY_LOOK[deal.priority];
  const facts: [string, string][] = [];
  if (deal.region) facts.push(["Region", deal.region]);
  const size = [
    deal.physicians == null ? null : `${deal.physicians} ${deal.physicians === 1 ? "physician" : "physicians"}`,
    deal.locations == null ? null : `${deal.locations} ${deal.locations === 1 ? "location" : "locations"}`,
  ].filter((part) => part !== null);
  if (size.length > 0) facts.push(["Size", size.join(", ")]);
  if (intel?.ownership) facts.push(["Ownership", intel.ownership]);

  return (
    <header className="space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2.5">
          <h1 className="text-2xl [overflow-wrap:anywhere] sm:text-3xl">{deal.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={stage.tone} icon={stage.icon}>
              {stageTitle(DEAL_COLUMNS, deal.stage)}
            </StatusChip>
            {priority && (
              <StatusChip tone={priority.tone} icon={priority.icon}>
                {`${priority.label} priority`}
              </StatusChip>
            )}
            {onCustomers && (
              <GatedLink
                href="/customers"
                className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                otherwise={<span className="text-sm text-ink-2">On Customers</span>}
              >
                On Customers
              </GatedLink>
            )}
          </div>
          {facts.length > 0 && (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {facts.map(([term, value]) => (
                <div key={term} className="flex gap-1.5">
                  <dt className="text-ink-2">{term}</dt>
                  <dd className="text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {intel?.researchedAt && <p className="text-xs text-ink-2">{researchedLabel(intel.researchedAt)}</p>}
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          {intel?.fit && <FitMeter fit={intel.fit} />}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onEditDetails} className={`${quietButtonClass} bg-surface`}>
              <PencilIcon aria-hidden className="size-4" />
              Edit details
            </button>
            <button type="button" onClick={onEditIntel} className={`${quietButtonClass} bg-surface`}>
              <PencilIcon aria-hidden className="size-4" />
              Edit intelligence
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

/** What research found, each section left out when it has nothing. */
function Intelligence({
  deal,
  intel,
  onNextStep,
}: {
  deal: TableDeal;
  intel: DealIntel;
  onNextStep: (nextStep: string) => Promise<unknown>;
}) {
  const main = [
    (intel.summary || intel.angle) && (
      <Section key="read" title="Summary">
        {intel.summary && <p className="text-sm whitespace-pre-line text-ink">{intel.summary}</p>}
        {intel.angle && (
          <div className="mt-4 border-l-2 border-brand pl-4">
            <h3 className="text-xs font-medium text-ink-2">Angle</h3>
            <p className="mt-0.5 text-sm text-ink">{intel.angle}</p>
          </div>
        )}
      </Section>
    ),
    intel.signals.length > 0 && (
      <Section key="signals" title="Signals">
        <SignalsTimeline signals={intel.signals} />
      </Section>
    ),
    intel.people.length > 0 && (
      <Section key="people" title="People">
        <PeopleList people={intel.people} />
      </Section>
    ),
  ].filter(Boolean);
  const aside = [
    hasTechAndBilling(intel) && (
      <Section key="tech" title="Tech and billing">
        <TechAndBilling intel={intel} />
      </Section>
    ),
    intel.competitors.length > 0 && (
      <Section key="competitors" title="Competitors">
        <CompetitorList competitors={intel.competitors} />
      </Section>
    ),
    hasPoints(intel) && (
      <Section key="points" title="Pain points, talking points and risks">
        <PointLists intel={intel} />
      </Section>
    ),
    intel.sources.length > 0 && (
      <Section key="sources" title="Sources">
        <SourceLinks sources={intel.sources} />
      </Section>
    ),
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      {intel.nextBestAction && (
        <NextBestAction action={intel.nextBestAction} nextStep={deal.nextStep} onTake={onNextStep} />
      )}
      {(main.length > 0 || aside.length > 0) && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {main.length > 0 && <div className="space-y-6">{main}</div>}
          {aside.length > 0 && <div className="space-y-6">{aside}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The one thing research says to do next, and a button that makes it the
 * deal's next step (`deals.update`). Once it is, the button says so.
 */
function NextBestAction({
  action,
  nextStep,
  onTake,
}: {
  action: string;
  nextStep: string | null;
  onTake: (nextStep: string) => Promise<unknown>;
}) {
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = nextStep?.trim() === action.trim();
  return (
    <section
      aria-labelledby={headingId}
      className="wash-brand rounded-card bg-panel p-5 shadow-soft sm:p-6"
    >
      <h2 id={headingId} className="text-sm font-medium text-brand">
        Next best action
      </h2>
      <p className="mt-1.5 max-w-3xl text-lg leading-snug text-ink">{action}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {taken ? (
          <StatusChip tone="success" icon={CheckIcon}>
            It is the next step
          </StatusChip>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onTake(action);
              } catch (failure) {
                setError(messageOf(failure, "The next step could not be saved. Try again."));
              } finally {
                setBusy(false);
              }
            }}
            className={primaryButtonClass}
          >
            {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            Make it the next step
          </button>
        )}
        {!taken && (
          <p className="text-xs text-ink-2">
            {nextStep === null ? "The deal has no next step yet." : `Next step now: ${nextStep}`}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** The deal as the board holds it: who, how much, what next, when last, the notes. */
function DealFacts({ deal, now }: { deal: TableDeal; now: number | null }) {
  const rows: [string, ReactNode][] = [
    ["Contact", deal.contact ?? <span className="text-ink-2">None given</span>],
    [
      "Monthly fee",
      deal.amount === null ? <span className="text-ink-2">None given</span> : formatValue(deal.amount, "currency", "USD"),
    ],
    ["Next step", deal.nextStep ?? <span className="text-ink-2">None yet</span>],
    [
      "Last activity",
      deal.lastActivityAt === null ? (
        <span className="text-ink-2">No date</span>
      ) : now === null ? (
        formatPeriod("day", localIsoDate(deal.lastActivityAt))
      ) : (
        lastActivityLabel(deal.lastActivityAt, now)
      ),
    ],
  ];
  return (
    <Section title="On the board">
      <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-ink-2">{term}</dt>
            <dd className="min-w-0 text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {deal.notes && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-ink-2">Notes</h3>
          <p className="mt-1 text-sm whitespace-pre-line text-ink">{deal.notes}</p>
        </div>
      )}
    </Section>
  );
}
