"use client";

import Link from "next/link";
import { Suspense } from "react";
import { PRODUCT } from "@convex/lib/identity";
import { WaitingLink } from "@/components/approvals/waiting-link";
import { AgentsPanel } from "@/components/assistant/agents-panel";
import { BriefArchive } from "@/components/assistant/brief-archive";
import { Chat, RunnerStatus } from "@/components/assistant/chat/chat";
import { ThisWeek } from "@/components/assistant/this-week";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The owner's Assistant: "work with Claude". The owner's alone (the
 * `personal` area in src/lib/nav.ts; every function it reads is `ownerQuery`
 * / `ownerMutation`, convex/assistant.ts and convex/chat.ts).
 *
 * Chat first, as the page's main column: the one place to ask Claude
 * (answered live by Claude on the owner's Mac). A proposal the chat makes is
 * shown under its answer with /approvals' own row; what waits is decided on
 * /approvals, and this page carries one line to it. Then the briefs of the
 * last week, what the agents did this week, and their switches. The
 * connected clients and the record of calls are set-up, on a page of their own
 * (Settings › Connections, /settings/connections). The brief is the company in view's.
 */
export default function AssistantPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Assistant"
        purpose={
          <>
            Work with your own Claude in {PRODUCT.name}. Only you can open this page.{" "}
            <Link href="/settings/connections" className="text-brand underline-offset-4 hover:underline">
              Connected clients and recent calls
            </Link>
          </>
        }
        aside={<RunnerStatus />}
      />
      <WaitingLink />

      {/* The chat reads the open conversation from the address, which needs a Suspense boundary. */}
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-card" />}>
        <Chat />
      </Suspense>
      <BriefArchive />
      <ThisWeek />
      <AgentsPanel />
    </div>
  );
}
