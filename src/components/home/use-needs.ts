"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { METRICS } from "@convex/lib/metricRegistry";
import { NOTIFICATION_PAGE } from "@convex/lib/limits";
import { intercomLink } from "@convex/lib/support";
import { needsYou } from "@convex/lib/supportMetrics";
import { useInbox } from "@/components/approvals/inbox";
import { useCompany } from "@/components/company-provider";
import {
  useAgreements,
  useClinics,
  useDeals,
  useInvestors,
  useObligations,
  usePartners,
  usePullsInView,
} from "@/components/dashboard/reads";
import { useMyPulls } from "@/components/engineering/use-my-pulls";
import { useMyBoard } from "@/components/today/my-tasks";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { rowSentence } from "@/lib/approvals/inbox";
import { pageServes } from "@/lib/company";
import { tasksForToday } from "@/lib/dashboard/my-tasks";
import { localIsoDate } from "@/lib/dates";
import { linkOf } from "@/lib/engineering/flow";
import { attentionItems, knownTile, sortAttention, type AttentionItem } from "@/lib/metrics/scorecard";
import { sentenceOf, type Notification } from "@/lib/notifications";
import { rankNeeds, type Need } from "@/lib/today/needs";
import { ruleItems } from "@convex/lib/attention/overview";

// What "Needs you" reads, each behind the rule its own page keeps: a query
// the server would refuse is never sent (each hook below skips it), and what
// the viewer was never sent adds nothing. The list is not said until every
// read the viewer is sent has arrived, so "Nothing needs you" is never said
// too soon.

/** How many unread notifications the list holds; the rest are in the bell's panel. */
export const NOTIFICATIONS_SHOWN = 5;

const GTM_SECTIONS: readonly string[] = ["gtm", "marketing"];

/**
 * The company's attention items for the company in view, as the Dashboard
 * listed them. Figures and sources are the scorecard's (the Dashboard's own
 * area); a viewer with Go to market and not the scorecard hears of its
 * figures alone, as Today told them. Each pipeline, clinic, obligation and
 * pull-request read is skipped for a viewer without its area.
 */
function useAttention(): AttentionItem[] | undefined {
  const viewer = useViewer();
  const company = useCompany();
  const data = useScorecard();
  const now = useNow();
  const usDeals = useDeals("us");
  const kzDeals = useDeals("kz");
  const investors = useInvestors();
  const usPartners = usePartners("us");
  const kzPartners = usePartners("kz");
  const clinics = useClinics();
  const obligations = useObligations();
  const agreements = useAgreements();
  const pulls = usePullsInView();
  // Open handoffs, for a viewer with the board; only when each began is sent.
  const board = viewer.can("board");
  const handoffs = useQuery(api.handoffs.waiting, board ? {} : "skip");
  return useMemo(() => {
    if (
      data === undefined ||
      now === null ||
      usDeals === undefined ||
      kzDeals === undefined ||
      investors === undefined ||
      usPartners === undefined ||
      kzPartners === undefined ||
      clinics === undefined ||
      obligations === undefined ||
      agreements === undefined ||
      pulls === undefined ||
      (board && handoffs === undefined)
    ) {
      return undefined;
    }
    const scorecard = viewer.can("scorecard");
    const gtmOnly =
      !scorecard && viewer.can("gtm") && viewer.companies.includes("us") && pageServes(company, "/gtm");
    const figures = scorecard
      ? attentionItems(data.tiles, data.sources, now)
      : gtmOnly
        ? attentionItems(
            data.tiles.filter((tile) =>
              GTM_SECTIONS.includes(METRICS.find((m) => knownTile(m, tile))?.section ?? ""),
            ),
            {},
            now,
          )
        : [];
    // Every other rule is the agent's own list (`ruleItems`), over what this
    // viewer was sent: a read they may not make arrived empty.
    return sortAttention([
      ...figures,
      ...ruleItems(
        {
          // A failing main branch from the tiles (the scorecard's), and stuck
          // pull requests counted from the list (engineering's).
          tiles: scorecard ? data.tiles : [],
          sources: {},
          pulls,
          usDeals: usDeals ?? {},
          kzDeals: kzDeals ?? {},
          investors: investors ?? {},
          partners: [...Object.values(usPartners ?? {}).flat(), ...Object.values(kzPartners ?? {}).flat()],
          customers: clinics?.customers ?? [],
          lastPushAt: clinics?.lastPushAt ?? null,
          obligations: obligations ?? [],
          handoffs: handoffs?.filter((row) => company === null || row.company === company),
          agreements: agreements ?? [],
        },
        now,
        localIsoDate(now),
      ),
    ]);
  }, [viewer, company, data, now, usDeals, kzDeals, investors, usPartners, kzPartners, clinics, obligations, agreements, pulls, board, handoffs]);
}

/**
 * What waits in the owner's approvals inbox for the company in view: the same
 * query, with the same arguments, as /approvals and its navigation count
 * (`useInbox`), so the rows here and the count there agree. Anyone else's:
 * none, and none asked for.
 */
function useProposals() {
  const { isOwner, can } = useViewer();
  // `assistant.inbox` is an `ownerQuery`: the owner, who alone holds `personal`.
  // The one read of what waits (both companies), as /approvals and its count.
  const owner = isOwner && can("personal");
  const listed = useInbox(owner);
  if (!owner) return [];
  return listed;
}

/**
 * The owner's bots refused more than five times in the last hour, by the
 * page's clock (a query reads none). Anyone else: none, and none asked for.
 */
function useRefusedBots() {
  const { isOwner, can } = useViewer();
  const now = useNow();
  const owner = isOwner && can("personal");
  // Asked once a minute, not on every tick of the page's clock.
  const since = now === null ? null : Math.floor(now / 60_000) * 60_000 - 60 * 60 * 1000;
  const rows = useQuery(api.bots.refusedLately, owner && since !== null ? { since } : "skip");
  if (!owner) return [];
  return rows;
}

/** The newest unread notifications and how many are unread, as the bell's panel reads them. */
function useUnread(): { rows: Notification[]; unread: number } | undefined {
  const page = useQuery(api.notifications.mine, { count: NOTIFICATION_PAGE });
  const unread = useQuery(api.notifications.unreadCount);
  if (page === undefined || unread === undefined) return undefined;
  return { rows: page.rows.filter((row) => !row.read).slice(0, NOTIFICATIONS_SHOWN), unread };
}

function useTasks() {
  const { allowed, board, company, email } = useMyBoard();
  const now = useNow();
  // Without the board, or with no address on record, nothing can be the viewer's.
  if (!allowed || email === null) return { due: [], fresh: [] };
  if (board === undefined || now === null) return undefined;
  return tasksForToday(board, { email, company, today: localIsoDate(now), now });
}

/** The viewer's own decisions due for a revisit, by their own day. Without Memory: none asked for. */
function useRevisits() {
  const { can } = useViewer();
  const now = useNow();
  const allowed = can("memory");
  const rows = useQuery(api.decisions.mineToRevisit, allowed && now !== null ? { today: localIsoDate(now) } : "skip");
  return allowed ? rows : [];
}

/**
 * Globex's customers who had waited on a person more than four hours at
 * Intercom's last push, for a viewer with Support and Globex in view.
 * Anyone else: none, and the inbox is not asked for.
 */
function useSupportWaits() {
  const { can, companies } = useViewer();
  const company = useCompany();
  const allowed = can("support") && companies.includes("kz") && pageServes(company, "/support");
  const inbox = useQuery(api.support.overview, allowed ? {} : "skip");
  if (!allowed) return [];
  if (inbox === undefined) return undefined;
  const pushedAt = inbox.status.lastOkAt;
  if (pushedAt === null) return [];
  return needsYou(inbox.rows, pushedAt).map((wait) => ({
    id: wait.intercomId,
    waitedMs: wait.waitedMs,
    pageArea: wait.pageArea,
    fin: wait.fin,
    href: intercomLink(inbox.appId, wait.intercomId),
  }));
}

export type NeedsData = {
  rows: Need[];
  /** The rows' sources, for a row that acts on its own (a notification marks itself read). */
  notifications: ReadonlyMap<string, Notification>;
  /** Unread notifications beyond those listed: in the bell's panel. */
  moreUnread: number;
};

/**
 * Everything that needs the viewer, ranked (`rankNeeds`), or undefined until
 * every list they are sent has arrived.
 */
export function useNeeds(): NeedsData | undefined {
  const viewer = useViewer();
  const now = useNow();
  const attention = useAttention();
  const proposals = useProposals();
  const unread = useUnread();
  const tasks = useTasks();
  const revisits = useRevisits();
  const pulls = useMyPulls();
  const support = useSupportWaits();
  const bots = useRefusedBots();

  return useMemo(() => {
    if (
      now === null ||
      attention === undefined ||
      proposals === undefined ||
      unread === undefined ||
      tasks === undefined ||
      revisits === undefined ||
      pulls === undefined ||
      support === undefined ||
      bots === undefined
    ) {
      return undefined;
    }
    // Where a notification leads: its task on the board, or its decision on Memory.
    const target = (row: Notification) =>
      row.taskId !== null && viewer.can("board")
        ? `/board?task=${row.taskId}`
        : row.decisionId !== null && viewer.can("memory")
          ? `/memory?decision=${row.decisionId}`
          : null;
    const rows = rankNeeds({
      now,
      attention,
      approvals: proposals.map((row) => ({
        id: row.id,
        text: rowSentence(row, now),
        createdAt: row.createdAt,
        // That row on /approvals, brought into view.
        href: `/approvals?id=${encodeURIComponent(row.id)}`,
      })),
      notifications: unread.rows.map((row) => {
        const { who, lead, title, tail } = sentenceOf(row, now);
        return {
          id: row.id,
          text: `${who} ${lead} ${title}${tail}`,
          createdAt: row.createdAt,
          taskId: row.taskId,
          decisionId: row.decisionId,
          href: target(row),
        };
      }),
      tasks: {
        due: tasks.due.map((task) => ({ id: task.id, title: task.title, due: task.due!, when: task.when })),
        fresh: tasks.fresh,
      },
      revisits,
      // Mine only where a GitHub username is on record: without one nothing is asked of the viewer.
      reviews:
        pulls === null || !pulls.read || !pulls.known
          ? []
          : pulls.reviews.map((row) => ({
              id: `${row.pull.repoId}#${row.pull.number}`,
              title: row.pull.title,
              href: linkOf(row.pull),
            })),
      support,
      bots: bots.map((bot) => ({ id: bot.id, name: bot.name, refusals: bot.refusals })),
    });
    return {
      rows,
      notifications: new Map(unread.rows.map((row) => [row.id, row])),
      moreUnread: Math.max(0, unread.unread - unread.rows.length),
    };
  }, [viewer, now, attention, proposals, unread, tasks, revisits, pulls, support, bots]);
}
