"use client";

import { Suspense, useId, type ReactNode } from "react";
import { PRODUCT } from "@convex/lib/identity";
import { ConnectedClients } from "@/components/assistant/connected-clients";
import { RecentCalls } from "@/components/assistant/recent-calls";
import { ConnectView } from "@/components/work/connect-view";
import { DomainLists } from "@/components/work/domain-lists";
import { GoogleConnection, GoogleResult } from "@/components/work/google-connection";
import { SourceSwitches } from "@/components/work/source-switches";
import { useViewer } from "@/hooks/use-viewer";
import { ingestUrlOf, mcpUrlOf } from "@/lib/work/ingest-url";

// All public and fixed at build time. The app's public origin, where one is
// set, is the address shown: it passes the request to the deployment
// (src/lib/os/pass-through.ts) and stays the same if the deployment changes.
const ENV = {
  osUrl: process.env.NEXT_PUBLIC_OS_URL,
  siteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
};
const INGEST_URL = ingestUrlOf(ENV);
const MCP_URL = mcpUrlOf(ENV);

/** One of the page's two parts: which way things flow, said once, then what does it. */
function Part({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div>
        <h2 id={id} className="text-lg">
          {title}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">{intro}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Settings › Connections: every place something is connected, in two parts.
 *
 * "Send your tools to Startup OS": for a teammate with Today, their personal
 * token and the prompt their own Claude runs (`connect.*`, the `today`
 * area); for the owner, the Google connection, the four work tools' switches
 * and the domain lists (`google.*`, `workTools.settings`..., `personal`).
 *
 * "Let Claude read Startup OS": the owner's alone, the connected clients (named
 * tokens and OAuth sign-ins) and the record of what they called (`assistant.*`).
 *
 * The page is Today's (src/lib/nav.ts); what is the owner's is mounted only
 * for the owner, so no owner query is ever declared for a teammate, and each
 * is refused inside Convex all the same. /today/connect,
 * /settings/work-tools and /assistant/connection redirect here.
 */
export default function ConnectionsPage() {
  const { isOwner, can } = useViewer();
  const owner = isOwner && can("personal");
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl sm:text-3xl">Connections</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          {owner
            ? `What ${PRODUCT.name} reads from your work tools, and how your Claude reaches ${PRODUCT.name}. Only you see the owner's parts of this page.`
            : `How your own Claude sends your mail, calendar, meeting notes and issues to ${PRODUCT.name}.`}
        </p>
      </header>

      <Part
        title={`Send your tools to ${PRODUCT.name}`}
        intro={
          owner
            ? "Gmail, Calendar, Linear and Fireflies, read only: nothing here can send, change or delete anything in those tools."
            : "A token for your own Claude, and the prompt it runs once a day. Only you see what it sends."
        }
      >
        {owner ? (
          <>
            {/* The result of a Google connect attempt, from the address the callback returned to. */}
            <Suspense fallback={null}>
              <GoogleResult />
            </Suspense>
            <GoogleConnection />
            <SourceSwitches />
            <DomainLists />
          </>
        ) : (
          <ConnectView ingestUrl={INGEST_URL} />
        )}
      </Part>

      {owner && (
        <Part
          title={`Let Claude read ${PRODUCT.name}`}
          intro="The clients your own AI connects with (Claude Code, claude.ai, a Grok bot, …), and the record of what each called. Only you can have them."
        >
          <ConnectedClients mcpUrl={MCP_URL} />
          <RecentCalls />
        </Part>
      )}
    </div>
  );
}
