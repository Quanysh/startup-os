import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { MEETING_NOTE_DAYS, type MirrorRecord } from "../lib/mirrorRules";
import { parseMeetings } from "./firefliesParse";
import { runMirror } from "./mirror";
import { askJson } from "./request";

const API = "https://api.fireflies.ai/graphql";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The most recent meetings looked at per read. */
const RECENT = 20;

// The only thing ever sent to Fireflies. A summary and its action items; the
// transcript itself (`sentences`) is never asked for, so it is never received.
export const RECENT_QUERY = `query Recent($limit: Int) {
  transcripts(limit: $limit) {
    id title date duration
    meeting_attendees { displayName email }
    summary { short_summary overview action_items }
  }
}`;

export const sync = internalAction({
  // `months` is accepted so "Run now" on the sources page can start this; it is not used.
  args: { months: v.optional(v.number()) },
  handler: async (ctx) =>
    // Notes accumulate, so "nothing" is never a reason to change what is stored.
    runMirror(ctx, "fireflies", { allowEmpty: false }, async (now) => {
      const meetings = parseMeetings(
        await askJson({
          who: "Fireflies",
          what: "meetings",
          url: API,
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.FIREFLIES_API_KEY ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: RECENT_QUERY, variables: { limit: RECENT } }),
        }),
      );
      // One note per meeting, and none older than the notes are kept for: the
      // daily prune would only delete it again.
      const rows = new Map<string, MirrorRecord>();
      for (const meeting of meetings) {
        if (meeting.heldAt >= now - MEETING_NOTE_DAYS * DAY_MS) rows.set(meeting.meetingId, meeting);
      }
      return [...rows.values()];
    }),
});
