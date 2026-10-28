"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { DEV_STATUS_LABELS, type DevRequestStatus } from "@convex/lib/devRequests";
import { DEV_REPO } from "@convex/lib/features";
import { PRODUCT } from "@convex/lib/identity";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";

/**
 * A bot's "Requests" on Agents › Bots: what it asked Startup OS's developers
 * for (`dev_request`), each with its state, the developers' answer and links
 * to the GitHub issue and pull request. The owner's alone, as the tab is.
 * Titles and answers are text a bot or a routine wrote: shown as text.
 */

export type RequestRow = NonNullable<ReturnType<typeof useQuery<typeof api.devRequests.forBot>>>[number];

const TONES: Record<DevRequestStatus, StatusTone> = {
  filed: "neutral",
  issue_open: "info",
  fix_proposed: "info",
  needs_owner: "warning",
  answered: "neutral",
  shipped: "success",
  failed: "danger",
};

/** The repository requests are filed in (`DEV_REPO`), as a pattern. */
const REPO_PATTERN = DEV_REPO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A link's number when it is the repository's issue or pull request, else null (never shown). */
const numberOf = (url: string | null, kind: "issues" | "pull"): string | null =>
  url === null ? null : (new RegExp(`^https://github\\.com/${REPO_PATTERN}/${kind}/(\\d+)$`).exec(url)?.[1] ?? null);

const linkClass =
  "rounded-sm text-ink underline decoration-line underline-offset-2 outline-none hover:decoration-ink focus-visible:ring-3 focus-visible:ring-ring/50";

export function BotRequestList({ name, rows }: { name: string; rows: readonly RequestRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-3">No requests yet. A bot files one with dev_request when {PRODUCT.name} lacks something it needs.</p>;
  }
  return (
    <ul aria-label={`${name}'s requests`} className="divide-y divide-line">
      {rows.map((row) => {
        const issue = numberOf(row.issueUrl, "issues");
        const pr = numberOf(row.prUrl, "pull");
        return (
          <li key={row.id} className="min-w-0 space-y-1 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <StatusChip tone={TONES[row.status]} className="shrink-0">
                {DEV_STATUS_LABELS[row.status]}
              </StatusChip>
              <span className="min-w-0 break-words text-sm text-ink">{row.title}</span>
            </div>
            {row.decision !== null && <p className="break-words text-sm text-ink-2">{row.decision}</p>}
            {(issue !== null || pr !== null) && (
              <p className="flex flex-wrap gap-x-3 text-xs">
                {issue !== null && (
                  <a href={row.issueUrl!} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    Issue #{issue}
                  </a>
                )}
                {pr !== null && (
                  <a href={row.prUrl!} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    Pull request #{pr}
                  </a>
                )}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The tab: the bot's requests, newest first. */
export function BotRequests({ botId, name }: { botId: string; name: string }) {
  const rows = useQuery(api.devRequests.forBot, { botId });
  if (rows === undefined) return <Skeleton className="h-24 rounded-inner" />;
  return <BotRequestList name={name} rows={rows} />;
}
