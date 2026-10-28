import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { MirrorRecord } from "../lib/mirrorRules";
import { parseEvents } from "./calendarParse";
import { ConnectorError } from "./errors";
import { googleAccessToken } from "./googleAuth";
import { runMirror } from "./mirror";
import { askJson } from "./request";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Yesterday to nine days ahead: "today and the next seven days" in any time zone. */
const DAYS_AHEAD = 9;
const PAGE_SIZE = 250;
const MAX_PAGES = 5;
// What a meeting needs and no more. The description, the location and the
// meeting link are never asked for, so they are never received.
const FIELDS =
  "kind,nextPageToken,items(id,status,summary,visibility,eventType,start,end," +
  "attendees(email,displayName,responseStatus,self,resource)," +
  "conferenceData/entryPoints/entryPointType)";

export const sync = internalAction({
  // `months` is accepted so "Run now" on the sources page can start this; it is not used.
  args: { months: v.optional(v.number()) },
  handler: async (ctx) =>
    // A week with no meetings is a real answer, so an empty read is applied.
    runMirror(ctx, "google_calendar", { allowEmpty: true }, async (now) => {
      const headers = { Authorization: `Bearer ${await googleAccessToken(ctx)}` };
      const window = {
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(PAGE_SIZE),
        timeMin: new Date(now - DAY_MS).toISOString(),
        timeMax: new Date(now + DAYS_AHEAD * DAY_MS).toISOString(),
        fields: FIELDS,
      };

      // By id: a meeting that straddles two pages is one meeting.
      const rows = new Map<string, MirrorRecord>();
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams(pageToken === null ? window : { ...window, pageToken });
        const { rows: found, next } = parseEvents(
          await askJson({ who: "Google Calendar", what: "events", url: `${API}?${query}`, headers }),
        );
        for (const row of found) rows.set(row.eventId, row);
        if (next === null) return [...rows.values()];
        pageToken = next;
      }
      // Never a truncated week: a meeting left off the page is a missed meeting.
      throw new ConnectorError("The calendar has more than 1,250 events in ten days.");
    }),
});
