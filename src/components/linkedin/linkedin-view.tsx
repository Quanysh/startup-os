"use client";

import { useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { needsYou } from "@convex/lib/linkedin";
import { AttentionRows } from "@/components/attention-list";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { Panel, primaryButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, companyIds, DEFAULT_COMPANY } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { datedPosts, filterPosts, readView, writeView, type View } from "@/lib/linkedin/view";
import { lastChange } from "@/lib/source-freshness";
import { Calendar } from "./calendar";
import { PostEditor } from "./post-editor";
import { Filters, PostsTable } from "./posts-table";
import { StatsPanel } from "./stats-panel";

const NAMES = { us: COMPANIES.us.name, kz: COMPANIES.kz.name } as const;

/**
 * /linkedin: the content calendar for the company pages and the named people's
 * profiles, what waits on a person, and how the posts did. Posts and figures
 * are typed here or sent by a bot through the owner's agent; nothing is posted
 * to LinkedIn from here. The view lives in the address. Every row is the
 * server's to send: only the viewer's companies', and only with Go to market.
 */
export function LinkedinView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const now = useNow();
  const company = useCompany();
  const { companies } = useViewer();
  const view = readView(new URLSearchParams(params.toString()));
  const data = useQuery(api.linkedin.list, { company: company ?? undefined });
  /** The post open in the form, "new" for a new one, or null. */
  const [opened, setOpened] = useState<string | null>(null);
  const [newOn, setNewOn] = useState<string | null>(null);
  const inView = company === null ? companies : [company];

  const setView = (next: View) => {
    const query = writeView(next);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  const open = (id: string | null, day: string | null = null) => {
    setOpened(id);
    setNewOn(day);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="LinkedIn"
        purpose={`The posts ${companyIds()
          .map((id) => COMPANIES[id].name)
          .join(", ")} and the team's profiles plan, write and publish on LinkedIn, and how each one did. Posts and figures are typed here or sent by a bot; nothing is posted from here.`}
        aside={
          <TypedFreshness
            label="Posts and figures"
            at={data === undefined ? undefined : lastChange(data.posts.map((post) => ({ changedAt: post.updatedAt })))}
          />
        }
      />
      {data === undefined || now === null ? (
        <div className="space-y-6" aria-busy>
          <Skeleton data-testid="linkedin-loading" className="h-32 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      ) : (
        (() => {
          const today = localIsoDate(now);
          const anchor = view.day ?? today;
          const dated = datedPosts(data.posts);
          const needs = needsYou(dated, today, inView, NAMES);
          const shown = filterPosts(data.posts, view);
          const editing = opened === null ? undefined : opened === "new" ? null : data.posts.find((post) => post.id === opened);
          const onAccount = datedPosts(filterPosts(data.posts, { ...view, status: null, q: "" }));
          return (
            <>
              <section aria-labelledby="li-needs" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
                <h2 id="li-needs" className="text-lg">
                  Needs you
                </h2>
                {needs.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-2">Nothing needs you: every scheduled post is drafted and every week has a post planned.</p>
                ) : (
                  <AttentionRows items={needs} className="mt-2" />
                )}
              </section>

              <StatsPanel posts={onAccount} today={today} now={now} companies={inView} targets={data.targets} />

              {editing !== undefined && (
                <Panel aria-label={editing === null ? "Add a post" : "Edit the post"}>
                  <h2 className="mb-4 text-lg [overflow-wrap:anywhere]">{editing === null ? "Add a post" : editing.title}</h2>
                  <PostEditor
                    key={`${opened}:${newOn}`}
                    row={editing}
                    company={company ?? companies[0] ?? DEFAULT_COMPANY}
                    companies={inView}
                    day={newOn}
                    today={today}
                    now={now}
                    onDone={() => open(null)}
                  />
                </Panel>
              )}

              <Panel className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg">Calendar</h2>
                  <button type="button" onClick={() => open("new")} className={primaryButtonClass}>
                    <PlusIcon aria-hidden className="size-4" />
                    Add a post
                  </button>
                </div>
                <Filters rows={data.posts} view={view} setView={setView} />
                <Calendar
                  rows={shown}
                  view={view}
                  setView={setView}
                  anchor={anchor}
                  today={today}
                  onOpen={(id) => open(id)}
                  onNew={(day) => open("new", day)}
                />
              </Panel>

              <Panel className="space-y-3">
                <h2 className="text-lg">All posts</h2>
                <p className="text-xs text-ink-2">The same filters as the calendar. The download holds what is shown.</p>
                <PostsTable rows={shown} now={now} showCompany={inView.length > 1} onOpen={(id) => open(id)} />
              </Panel>
            </>
          );
        })()
      )}
    </div>
  );
}
