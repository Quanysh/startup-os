"use client";

import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import type { AgentId } from "@convex/lib/agents";
import { KindTag } from "@/components/ui/status-chip";
import { AGENT_NAMES, AGENT_TONES, BRIEF_PAGE_LABELS, isBriefPage } from "@/lib/assistant/agents";

// A brief's lines, as Today and the Assistant's archive show them.
//
// **A model wrote every sentence.** It is rendered as text and nothing else:
// markup in one shows as the characters it is. A bullet's link is made only
// from the closed list of the app's own pages (`isBriefPage`), never from
// anything the bullet says.

export type BriefBullet = { agent: AgentId; text: string; page?: string };

/**
 * A brief's lines: the agent each is from, the sentence as text, and the
 * page it is about from the closed list. `compact` runs the agent's chip
 * into the line, for Today; otherwise the chips stand in a column of their own.
 */
export function BriefLines({ bullets, compact = false }: { bullets: readonly BriefBullet[]; compact?: boolean }) {
  return (
    <ul className={compact ? "space-y-2" : "space-y-3"} data-testid="brief-bullets">
      {bullets.map((bullet, index) => (
        <li
          key={index}
          className={
            compact
              ? "flex flex-col items-start gap-1 sm:flex-row sm:items-baseline sm:gap-x-2"
              : "grid gap-x-3 gap-y-1 sm:grid-cols-[11rem_1fr]"
          }
        >
          <span className="shrink-0">
            <KindTag tone={AGENT_TONES[bullet.agent]}>{AGENT_NAMES[bullet.agent]}</KindTag>
          </span>
          <span className="min-w-0 flex-1 text-sm text-ink [overflow-wrap:anywhere]">
            {bullet.text}
            {isBriefPage(bullet.page) && (
              <>
                {" "}
                <Link
                  href={bullet.page}
                  className="inline-flex items-center gap-1 rounded-sm font-medium whitespace-nowrap text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {BRIEF_PAGE_LABELS[bullet.page]}
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
