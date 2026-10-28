"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { useMarkets } from "@/components/dashboard/reads";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { pullsForMe, type MyPulls } from "@/lib/engineering/mine";

/**
 * The viewer's own pull requests for the companies in view, as the
 * dashboard's and Today's blocks read them:
 *
 *   null       not this viewer's (no engineering area): never asked for
 *   undefined  asked for, not yet answered
 *   a value    `read` is false where GitHub's list was never read
 *
 * Both reads are the engineering area's, and the GitHub username is the
 * caller's own: the server takes no argument that names a person.
 */
export function useMyPulls(): (MyPulls & { read: boolean }) | null | undefined {
  const allowed = useViewer().can("engineering");
  const list = useQuery(api.workTools.pullRequests, allowed ? {} : "skip");
  const mine = useQuery(api.team.myGithub, allowed ? {} : "skip");
  const now = useNow();
  const markets = useMarkets();
  // Keyed on what the list holds: `markets` is a new array each render.
  const marketKey = markets.join(",");
  const pulls = useMemo(
    () =>
      list === undefined || mine === undefined || now === null
        ? undefined
        : {
            ...pullsForMe(list.rows, {
              login: mine.login,
              companies: markets,
              now,
            }),
            read: list.readAt !== null,
          },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, mine, now, marketKey],
  );
  return allowed ? pulls : null;
}
