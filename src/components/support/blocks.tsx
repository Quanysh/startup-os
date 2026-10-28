import { CircleCheckIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { PRODUCT } from "@convex/lib/identity";
import { INTERCOM_TOKEN_ENV, inboxLink } from "@convex/lib/support";
import {
  FIN_RESULTS,
  FIN_RESULT_WORDS,
  OPEN_TOO_LONG_DAYS,
  SUPPORT_WINDOW_DAYS,
  type SupportFigures,
} from "@convex/lib/supportMetrics";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel } from "@/components/panel";
import { DataBody, DataCell, DataHead, DataHeader, DataRow, DataRowHeader, DataTable } from "@/components/ui/data-table";
import { COMPANIES } from "@/lib/company";
import { shareWords } from "@/lib/support/words";

/** A block of the page: a panel named by its heading. */
export function Block({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <Panel aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="text-base">
        {title}
      </h2>
      {note !== undefined && <p className="mt-1 max-w-3xl text-xs text-ink-2">{note}</p>}
      <div className="mt-4">{children}</div>
    </Panel>
  );
}

/** One quiet sentence, where a block has nothing to show. */
export const Quiet = ({ children }: { children: ReactNode }) => <p className="text-sm text-ink-3">{children}</p>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Chats begun each week for eight weeks: customers' and tests as two series
 * (the validated `--chart-1` / `--chart-2` pair) with a legend; other
 * products' chats and those with no page are counted in words under it. The
 * week in progress is drawn lighter, as "so far".
 */
export function ChatsByWeek({ figures }: { figures: SupportFigures }) {
  const other = figures.weeks.reduce((sum, week) => sum + week.other, 0);
  const unknown = figures.weeks.reduce((sum, week) => sum + week.unknown, 0);
  const notDrawn = [
    other > 0 ? `${other} from other products sharing the workspace` : null,
    unknown > 0 ? `${unknown} with no page known` : null,
  ].filter((part) => part !== null);
  return (
    <Block title="Chats a week" note="When each chat began, by where it began. Test chats come from staging, a local machine or Intercom's previews.">
      <MonthBars
        title="Chats a week"
        grain="week"
        mode="grouped"
        series={[
          { id: "customer", label: "Customers", color: "var(--chart-1)" },
          { id: "test", label: "Tests", color: "var(--chart-2)" },
        ]}
        rows={figures.weeks.map((week) => ({
          periodStart: week.weekStart,
          values: { customer: week.customer, test: week.test },
          ...(week.inProgress ? { note: "so far" } : {}),
        }))}
        format={(value) => String(value)}
      />
      {notDrawn.length > 0 && <p className="mt-3 text-xs text-ink-2">Not drawn: {notDrawn.join(", ")}.</p>}
    </Block>
  );
}

/** What Fin did with the customer chats begun in the window: each outcome, its count and its share. */
export function FinOutcomes({ figures }: { figures: SupportFigures }) {
  const { fin } = figures;
  return (
    <Block
      title="Fin's outcomes"
      note={`Customer chats begun in the last ${SUPPORT_WINDOW_DAYS} days. Intercom's assumed and confirmed resolutions are both "Resolved by Fin".`}
    >
      {fin.chats === 0 ? (
        <Quiet>No customer chat began in the last {SUPPORT_WINDOW_DAYS} days.</Quiet>
      ) : (
        <DataTable label={`Fin's outcomes, last ${SUPPORT_WINDOW_DAYS} days`} download="Fin's outcomes">
          <DataHead>
            <DataHeader>Outcome</DataHeader>
            <DataHeader numeric>Chats</DataHeader>
            <DataHeader numeric>Share</DataHeader>
          </DataHead>
          <DataBody>
            {FIN_RESULTS.map((result) => (
              <DataRow key={result}>
                <DataRowHeader>{FIN_RESULT_WORDS[result]}</DataRowHeader>
                <DataCell numeric>{fin.counts[result]}</DataCell>
                <DataCell numeric>{shareWords(fin.rates[result])}</DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}
    </Block>
  );
}

/** The help articles Fin used most. Titles are Intercom's text: rendered as text, never a link. */
export function TopArticles({ figures }: { figures: SupportFigures }) {
  return (
    <Block title="Help articles Fin used" note={`In customer chats begun in the last ${SUPPORT_WINDOW_DAYS} days.`}>
      {figures.articles.length === 0 ? (
        <Quiet>Fin used no help article in the last {SUPPORT_WINDOW_DAYS} days.</Quiet>
      ) : (
        <ol aria-label="Help articles Fin used most" className="divide-y divide-line">
          {figures.articles.map((article) => (
            <li key={article.title} className="flex items-baseline justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{article.title}</span>
              <span className="shrink-0 font-num text-xs text-ink-2">{plural(article.chats, "chat")}</span>
            </li>
          ))}
        </ol>
      )}
    </Block>
  );
}

/**
 * What to tidy in the inbox: test chats still open, and chats open more than
 * thirty days, each with the inbox's link. A count above zero is said with an
 * icon and words, in the watch ink.
 */
export function InboxHygiene({ figures, appId }: { figures: SupportFigures; appId: string | null }) {
  const href = inboxLink(appId);
  const lines = [
    { count: figures.hygiene.testOpen, words: (n: number) => `${plural(n, "test chat")} still open` },
    {
      count: figures.hygiene.openOver30Days,
      words: (n: number) => `${plural(n, "chat")} open more than ${OPEN_TOO_LONG_DAYS} days`,
    },
  ];
  return (
    <Block title="Inbox hygiene" note="Test chats left open and old open chats make the inbox harder to read.">
      <ul className="space-y-3 text-sm">
        {lines.map(({ count, words }) => (
          <li key={words(2)} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={count > 0 ? "flex items-center gap-1.5 font-medium text-warning-ink" : "flex items-center gap-1.5 text-ink-2"}>
              {count > 0 ? (
                <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
              ) : (
                <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-good" />
              )}
              {words(count)}
            </span>
            {count > 0 && href !== null && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Open the inbox
                <ExternalLinkIcon aria-hidden className="size-3.5" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/**
 * How Globex's Intercom reaches Startup OS, for when nothing can arrive yet:
 * the daily task on the owner's Mac reads it through Claude's Intercom
 * connector and pushes what is kept. Startup OS never calls Intercom itself.
 * The token is named; no value is ever shown.
 */
export function ConnectIntercom() {
  const id = useId();
  return (
    <Panel aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="text-base">
        Connect Intercom
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        Set up the daily Intercom task on the owner&apos;s Mac (docs/setup.md, &ldquo;Intercom&rdquo;). It
        reads the inbox through Claude&apos;s Intercom connector, changes nothing there, and sends {PRODUCT.name} only
        what this page shows: never a message or anything about the customer.
      </p>
      <ol className="mt-4 max-w-2xl list-decimal space-y-2 pl-5 text-sm text-ink">
        <li>Connect Claude on the owner&apos;s Mac to {COMPANIES.kz.name}&apos;s Intercom.</li>
        <li>
          The owner makes the push token and sets it as{" "}
          <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs [overflow-wrap:anywhere]">
            {INTERCOM_TOKEN_ENV}
          </code>{" "}
          on the Convex deployment and in the Mac&apos;s untracked .env.push. Never paste it into a chat or a file.
        </li>
        <li>Schedule the daily Intercom task. This page fills in after its first push.</li>
      </ol>
    </Panel>
  );
}
