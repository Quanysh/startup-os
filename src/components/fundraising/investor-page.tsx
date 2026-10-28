"use client";

import { useMutation, useQuery } from "convex/react";
import { ArchiveIcon, ArrowLeftIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { UNMAPPED } from "@convex/lib/pipelineStages";
import { LinkedContacts } from "@/components/contacts/linked-contacts";
import { OutcomesTimeline } from "@/components/outcomes/outcomes-timeline";
import { Panel, quietButtonClass } from "@/components/panel";
import { CardEditor } from "@/components/pipeline/card-editor";
import {
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { whenWritten } from "@/lib/assistant/words";
import { COMPANIES } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { formatPeriod, formatValue } from "@/lib/format";
import { investorCard, type InvestorExtras, type SyncStatus } from "@/lib/fundraising/sync";
import { INVESTOR_WORDS, SYNC_STATUS_LABELS, SYNC_WORDS, syncErrorWords } from "@/lib/fundraising/words";
import type { BoardCard } from "@/lib/pipeline/derive";
import { INVESTOR_COLUMNS, stageTitle } from "@/lib/pipeline/stages";
import { lastActivityLabel } from "@/lib/pipeline/table-sort";
import { INVESTOR_STAGE_LOOK } from "./investor-table";
import { SyncChips } from "./sync-chips";

/** What `investors.get` sends: the board's card, its sync, and whether it is archived. */
type InvestorDetail = BoardCard &
  Partial<InvestorExtras> & {
    archived?: boolean;
    archivedAt?: number | null;
    referralSource?: string | null;
  };

/** One row of `investors.syncHistory`: when, what became of it, and the ack's code. Nothing of Visible's. */
type SyncEvent = { at: number; status: SyncStatus; errorCode?: string };

const HISTORY_TONES: Record<SyncStatus, StatusTone> = {
  pending: "neutral",
  sent: "info",
  failed: "danger",
  confirmed: "success",
};

/**
 * One investor's page (`/fundraising/investors/[id]`): its fields as the
 * board holds them, with the board's editor and its rules (a Visible
 * investor's name, amount and stage are edited here and sent there; its
 * contact is Visible's), archive or restore, its sync with Visible (times,
 * statuses and the reasons in words, never what Visible holds), and its
 * Outcomes.
 *
 * Startup's only (fundraising is "us"): someone not on Startup is told so and
 * nothing is asked for. An id that is no investor is said in one line.
 */
export function InvestorPage({ investorId }: { investorId: string }) {
  const { companies } = useViewer();
  const onStartup = companies.includes("us");
  const ask = onStartup && investorId !== "";
  const id = investorId as Id<"investors">;
  const found = useQuery(api.investors.get, ask ? { id } : "skip") as InvestorDetail | null | undefined;
  const history = useQuery(api.investors.syncHistory, ask ? { id } : "skip") as
    | readonly SyncEvent[]
    | undefined;
  const now = useNow();
  const router = useRouter();
  const update = useMutation(api.investors.update);
  const remove = useMutation(api.investors.remove);
  const archive = useMutation(api.investors.archive);
  const restore = useMutation(api.investors.restore);
  const retrySync = useMutation(api.investors.retrySync);
  const [editing, setEditing] = useState(false);

  if (!onStartup) {
    return (
      <Quiet title={`Nothing here for ${COMPANIES.kz.name}`}>
        An investor&apos;s page is kept for {COMPANIES.us.name}&apos;s fundraising only.
      </Quiet>
    );
  }
  if (found === undefined) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  if (found === null) {
    return (
      <Quiet title="This investor is not here">
        It may have been deleted. Archived investors are listed under the board.
      </Quiet>
    );
  }

  const investor = investorCard(found);
  const archived = found.archived ?? (found.archivedAt != null);
  return (
    <div className="space-y-6">
      <Header
        investor={investor}
        archived={archived}
        onEdit={() => setEditing(true)}
        onArchive={() => archive({ id })}
        onRestore={() => restore({ id })}
        onRetry={() => retrySync({ id })}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Facts investor={investor} referralSource={found.referralSource ?? null} now={now} />
        <SyncHistory history={history} now={now} />
      </div>
      <OutcomesTimeline kind="investor" id={investor.id} />
      <LinkedContacts company="us" type="investor" recordId={investor.id} />

      {editing && (
        <CardEditor
          card={investor}
          words={INVESTOR_WORDS}
          columns={INVESTOR_COLUMNS}
          currency="USD"
          mirrorNamed="Visible"
          editable={investor.editable}
          note={SYNC_WORDS.editorNote}
          onSave={(edit) => update({ id, ...edit })}
          onDelete={async () => {
            await remove({ id });
            router.replace("/fundraising");
          }}
          onClose={() => setEditing(false)}
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
      href="/fundraising"
      className="inline-flex items-center gap-1.5 rounded text-sm text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon aria-hidden className="size-4" />
      Fundraising
    </Link>
  );
}

/** The investor's name, where it stands, its sync, and what can be done with it. */
function Header({
  investor,
  archived,
  onEdit,
  onArchive,
  onRestore,
  onRetry,
}: {
  investor: ReturnType<typeof investorCard>;
  archived: boolean;
  onEdit: () => void;
  onArchive: () => Promise<unknown>;
  onRestore: () => Promise<unknown>;
  onRetry: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const look = INVESTOR_STAGE_LOOK[investor.stage] ?? INVESTOR_STAGE_LOOK[UNMAPPED]!;

  const act = async (action: () => Promise<unknown>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      await action();
    } catch (failure) {
      setError(messageOf(failure, fallback));
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2.5">
          <h1 className="text-2xl [overflow-wrap:anywhere] sm:text-3xl">{investor.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={look.tone} icon={look.icon}>
              {stageTitle(INVESTOR_COLUMNS, investor.stage)}
            </StatusChip>
            {archived && (
              <StatusChip tone="neutral" icon={ArchiveIcon}>
                Archived
              </StatusChip>
            )}
            <SyncChips card={investor} onRetry={onRetry} className="flex flex-wrap items-center gap-1.5" />
          </div>
          {investor.stage === UNMAPPED && investor.sourceStage && (
            <p className="text-xs text-ink-2">{`In Visible: ${investor.sourceStage}`}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {archived ? (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => void act(onRestore, "That investor could not be restored. Try again.")}
              className={`${quietButtonClass} bg-surface`}
            >
              <RotateCcwIcon aria-hidden className="size-4" />
              Restore
            </button>
          ) : confirming ? (
            <span className="flex flex-wrap items-center gap-1 text-sm text-ink-2">
              Archive this investor? It can be restored.
              <button
                type="button"
                onClick={() => void act(onArchive, "That investor could not be archived. Try again.")}
                className={`${quietButtonClass} text-ink`}
              >
                Archive it
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={quietButtonClass}>
                Keep
              </button>
            </span>
          ) : (
            <>
              <button type="button" onClick={onEdit} className={`${quietButtonClass} bg-surface`}>
                <PencilIcon aria-hidden className="size-4" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className={`${quietButtonClass} bg-surface`}
              >
                <ArchiveIcon aria-hidden className="size-4" />
                Archive
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </header>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Panel aria-labelledby={id}>
      <h2 id={id} className="mb-3 text-sm font-medium text-ink">
        {title}
      </h2>
      {children}
    </Panel>
  );
}

/** The investor as the board holds it: who, how much, what next, when last, where from, the notes. */
function Facts({
  investor,
  referralSource,
  now,
}: {
  investor: ReturnType<typeof investorCard>;
  referralSource: string | null;
  now: number | null;
}) {
  const none = (text: string) => <span className="text-ink-2">{text}</span>;
  const rows: [string, ReactNode][] = [
    ["Contact", investor.contact ?? none("None given")],
    ["Cheque", investor.amount === null ? none("None given") : formatValue(investor.amount, "currency", "USD")],
    ["Next step", investor.nextStep ?? none("None yet")],
    [
      "Last activity",
      investor.lastActivityAt === null
        ? none("No date")
        : now === null
          ? formatPeriod("day", localIsoDate(investor.lastActivityAt))
          : lastActivityLabel(investor.lastActivityAt, now),
    ],
    ["Source", investor.source === "visible" ? "Visible" : "Added here"],
  ];
  if (referralSource) rows.push(["Introduced through", referralSource]);
  return (
    <Section title="On the board">
      <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-ink-2">{term}</dt>
            <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {investor.notes && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-ink-2">Notes</h3>
          <p className="mt-1 text-sm whitespace-pre-line text-ink">{investor.notes}</p>
        </div>
      )}
    </Section>
  );
}

/**
 * Each change sent toward Visible: when, what became of it, and for a failure
 * the reason in words. Times, statuses and codes only: nothing Visible holds.
 */
function SyncHistory({ history, now }: { history: readonly SyncEvent[] | undefined; now: number | null }) {
  return (
    <Section title="Sync with Visible">
      {history === undefined ? (
        <Skeleton className="h-16 rounded-inner" />
      ) : history.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing has been sent to Visible for this investor.</p>
      ) : (
        <DataTable label="Sync history" bleed={false} download={false}>
          <DataHead>
            <DataHeader narrow>When</DataHeader>
            <DataHeader narrow>Status</DataHeader>
            <DataHeader>Reason</DataHeader>
          </DataHead>
          <DataBody>
            {history.map((event, index) => (
              <DataRow key={`${event.at}-${index}`}>
                <DataCell narrow className="whitespace-nowrap text-ink-2">
                  {now === null ? formatPeriod("day", localIsoDate(event.at)) : whenWritten(event.at, now)}
                </DataCell>
                <DataCell narrow>
                  <StatusChip tone={HISTORY_TONES[event.status]}>{SYNC_STATUS_LABELS[event.status]}</StatusChip>
                </DataCell>
                <DataCell>
                  {event.status === "failed" ? (
                    <span title={event.errorCode}>{syncErrorWords(event.errorCode)}</span>
                  ) : (
                    <Blank />
                  )}
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}
    </Section>
  );
}
