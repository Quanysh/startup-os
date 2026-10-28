import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { MirrorRecord } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";
import { parseIssuePage } from "./linearParse";
import { runMirror } from "./mirror";
import { askJson } from "./request";

const API = "https://api.linear.app/graphql";
const MAX_PAGES = 10;

// The only thing ever sent to Linear, and it is a query: nothing in this
// codebase can change an issue. Open issues, and those finished in the last
// fourteen days.
export const BOARD_QUERY = `query Board($after: String) {
  viewer { id }
  issues(
    first: 100
    after: $after
    orderBy: updatedAt
    filter: {
      or: [
        { state: { type: { in: ["backlog", "unstarted", "started"] } } }
        { state: { type: { eq: "completed" } }, completedAt: { gt: "-P14D" } }
      ]
    }
  ) {
    nodes {
      id identifier title url priority dueDate updatedAt
      state { name type }
      team { key name }
      assignee { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const sync = internalAction({
  // `months` is accepted so "Run now" on the sources page can start this; it is not used.
  args: { months: v.optional(v.number()) },
  handler: async (ctx) =>
    // A workspace with no issue at all is far more likely a broken read, so
    // an empty answer is recorded and changes nothing.
    runMirror(ctx, "linear", { allowEmpty: false }, async () => {
      const headers = {
        // A personal API key goes in as it is: Linear takes no "Bearer" here.
        Authorization: process.env.LINEAR_API_KEY ?? "",
        "Content-Type": "application/json",
      };
      // By id: an issue updated between two pages can appear on both.
      const rows = new Map<string, MirrorRecord>();
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { rows: found, next } = parseIssuePage(
          await askJson({
            who: "Linear",
            what: "issues",
            url: API,
            method: "POST",
            headers,
            body: JSON.stringify({ query: BOARD_QUERY, variables: { after } }),
          }),
        );
        for (const row of found) rows.set(row.issueId, row);
        if (next === null) return [...rows.values()];
        after = next;
      }
      // Never a truncated board: an issue left off it is work that goes unseen.
      throw new ConnectorError("Linear has more than 1,000 issues to show.");
    }),
});
