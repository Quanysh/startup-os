"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { MAX_MEMBERS } from "@convex/lib/roles";
import { Panel } from "@/components/panel";
import { ActionsHeader, DataHead, DataHeader, DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/hooks/use-viewer";
import { AddTeammate } from "./add-teammate";
import { OwnerRow } from "./owner-row";
import { RolesCard } from "./roles-card";
import { companyNames } from "./company-checks";
import { RecentChanges } from "./recent-changes";
import { TeammateRow } from "./teammate-row";

/** What someone without the Team page reads in its place. */
export const TEAM_NOT_YOURS =
  "Only the owner, and people the owner gives the Team page, manage the team.";

/**
 * Who else may use the OS: the owner's page, and that of a teammate the owner
 * gave the Team page (the `team` area). Anyone else gets a line and no query:
 * `team.list` refuses them, and a refused query breaks the page. That is
 * presentation; the refusal itself is the server's.
 *
 * Two things here are the owner's alone, and are asked for only by the
 * owner: the owner's own row with its Telegram and GitHub usernames (an
 * owner has no `members` row to hold them) and the record of what the
 * team's managers changed.
 */
export function TeamView() {
  const viewer = useViewer();
  const manages = viewer.can("team");
  const isOwner = viewer.isOwner;
  const team = useQuery(api.team.list, manages ? {} : "skip");

  if (!manages) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-2xl sm:text-3xl">Team</h1>
        </header>
        <Panel>
          <p className="text-sm text-ink-2">{TEAM_NOT_YOURS}</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl sm:text-3xl">Team</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          Who else may sign in to the OS, which pages each can open, and for which company.
        </p>
      </header>

      <Panel aria-labelledby="team-access">
        <h2 id="team-access" className="text-base">
          How access works
        </h2>
        <div className="mt-2 max-w-2xl space-y-1.5 text-sm text-ink-2">
          <p>
            You pick, for each teammate, the pages they can open. A role is a label and a place to
            start: choosing one ticks its usual pages, and you can tick or untick any of them.
            A role also says what a person&rsquo;s Dashboard and Today are arranged for; that
            orders what they already have and opens nothing.
          </p>
          <p>
            A teammate sees only the figures, deals, clients and tasks of the companies they are
            on, so a page kept for one company is empty for someone who is not on it.
          </p>
        </div>
      </Panel>

      {!isOwner && (
        <Panel aria-labelledby="team-yours">
          <h2 id="team-yours" className="text-base">
            What you can do here
          </h2>
          <div className="mt-2 max-w-2xl space-y-1.5 text-sm text-ink-2">
            <p>
              The owner gave you this page. You can add people, choose their ordinary pages and
              remove them, for {companyNames(viewer.companies)}.
            </p>
            <p>You cannot change or remove yourself. Only the owner can.</p>
            <p>
              Only the owner gives Sources and Telegram, or Team, and only the owner changes
              someone who manages the team. Payroll and costs are the owner&apos;s alone.
            </p>
            <p>
              The owner is not listed and cannot be changed here. What you change is recorded for
              the owner.
            </p>
          </div>
        </Panel>
      )}

      <Panel aria-labelledby="team-people">
        <h2 id="team-people" className="text-base">
          People
        </h2>
        <DataTable caption="People" className="min-w-[54rem]" boxClassName="mt-2">
          <DataHead>
            <DataHeader pinned>Person</DataHeader>
            <DataHeader>Role</DataHeader>
            <DataHeader>Companies</DataHeader>
            <DataHeader>Pages</DataHeader>
            <DataHeader>Telegram</DataHeader>
            <DataHeader>Signed in</DataHeader>
            <ActionsHeader />
          </DataHead>
          {/* The owner's own row, for the owner: nobody else is shown or can change the owner.
              The owner's Telegram and GitHub usernames are set and reset there. */}
          {isOwner && <OwnerRow />}
          {team?.map((member) => (
            <TeammateRow key={member.id} member={member} />
          ))}
        </DataTable>
        {team === undefined ? (
          <Skeleton className="mt-2 h-16 rounded-inner" />
        ) : (
          team.length === 0 && (
            <p className="mt-2 text-sm text-ink-3">No teammates yet. Add the first one below.</p>
          )
        )}
      </Panel>

      {/* The owner's alone: the server refuses anyone else a change to a role. */}
      {isOwner && <RolesCard />}

      <Panel aria-labelledby="team-add">
        <h2 id="team-add" className="text-base">
          Add a teammate
        </h2>
        <p className="mt-1 text-sm text-ink-2">Up to {MAX_MEMBERS} people.</p>
        <div className="mt-4">
          <AddTeammate />
        </div>
      </Panel>

      {isOwner && <RecentChanges />}
    </div>
  );
}
