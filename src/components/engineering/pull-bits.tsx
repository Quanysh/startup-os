import type { RepoMain } from "@convex/lib/sharedRecords";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { linkOf, type PullRow, type Stage } from "@/lib/engineering/flow";
import type { Owner } from "@/lib/engineering/view";
import { cn } from "@/lib/utils";

// The small parts the flow, the strip and the tables share. Everything a
// pull request brings from GitHub (its title, a name, a login) is rendered as
// text: React escapes it, nothing here sets HTML, and the only href is the
// one `linkOf` rebuilds.

/**
 * A pull request's title, linked to GitHub in a new tab. Where the stored
 * address is not GitHub's own for it, the title is plain text: a link is
 * never made from anything else.
 */
export function TitleLink({ pull, className }: { pull: PullRow; className?: string }) {
  const href = linkOf(pull);
  if (href === null) return <span className={className}>{pull.title}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "rounded-sm outline-none hover:text-brand hover:underline focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      {pull.title}
    </a>
  );
}

/** Who owns a pull request: initials for the eye (no picture is fetched), the name for everyone. */
export function OwnerChip({ owner, className }: { owner: Owner; className?: string }) {
  return (
    <span data-testid="owner" className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {/* Drawn initials: the name beside them is what a table's download says. */}
      <span
        aria-hidden
        data-export-skip=""
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-kind-slate-soft text-[10px] font-semibold text-kind-slate-ink"
      >
        {owner.initials}
      </span>
      <span className="min-w-0 truncate">{owner.name}</span>
    </span>
  );
}

/**
 * How a head commit's checks read. First matching row wins:
 *   passing → Checks passing (success)
 *   failing → Checks failing (danger)
 *   pending → Checks running (info)
 *   none    → No checks      (neutral)
 */
export function checksStatus(checks: RepoMain): { label: string; tone: StatusTone } {
  if (checks === "passing") return { label: "Checks passing", tone: "success" };
  if (checks === "failing") return { label: "Checks failing", tone: "danger" };
  if (checks === "pending") return { label: "Checks running", tone: "info" };
  return { label: "No checks", tone: "neutral" };
}

export function ChecksChip({ checks }: { checks: RepoMain }) {
  const { label, tone } = checksStatus(checks);
  return <StatusChip tone={tone}>{label}</StatusChip>;
}

/** A stage's chip in the table: what it is, in the tone of how far along it is. */
export const STAGE_TONE: Record<Stage, StatusTone> = {
  draft: "neutral",
  waiting_for_review: "info",
  changes_requested: "warning",
  approved: "success",
  merged: "success",
  closed: "neutral",
};

/** Who is asked to review, in words; null where nobody is. */
export function reviewersLine(pull: Pick<PullRow, "reviewers" | "reviewersRequested">): string | null {
  if (pull.reviewersRequested === 0) return null;
  const more = pull.reviewersRequested - pull.reviewers.length;
  if (pull.reviewers.length === 0) {
    return `Asked to review: ${more} ${more === 1 ? "reviewer" : "reviewers"}`;
  }
  return `Asked to review: ${pull.reviewers.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
