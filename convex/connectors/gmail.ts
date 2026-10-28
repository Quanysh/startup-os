import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { isOwnerEmail } from "../authOwner";
import type { MirrorRecord } from "../lib/mirrorRules";
import { parseThread, parseThreadList } from "./gmailParse";
import { googleAccessToken } from "./googleAuth";
import { runMirror } from "./mirror";
import { askJson } from "./request";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** The newest inbox threads looked at per read. */
const MAX_THREADS = 50;
const AT_ONCE = 10;
const HEADERS = ["From", "Subject", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"];
// Labels, a time and headers. Never the snippet, never a body.
const THREAD_QUERY = [
  "format=metadata",
  ...HEADERS.map((name) => `metadataHeaders=${name}`),
  `fields=${encodeURIComponent("messages(labelIds,internalDate,payload/headers)")}`,
].join("&");

export const sync = internalAction({
  // `months` is accepted so "Run now" on the sources page can start this; it is not used.
  args: { months: v.optional(v.number()) },
  handler: async (ctx) =>
    // An inbox with nothing waiting is a real answer, so an empty read is applied.
    runMirror(ctx, "gmail", { allowEmpty: true }, async () => {
      const headers = { Authorization: `Bearer ${await googleAccessToken(ctx)}` };
      const ids = parseThreadList(
        await askJson({
          who: "Gmail",
          what: "the inbox",
          url: `${API}/threads?labelIds=INBOX&maxResults=${MAX_THREADS}&fields=${encodeURIComponent("threads/id")}`,
          headers,
        }),
      );
      const rows: MirrorRecord[] = [];
      for (let i = 0; i < ids.length; i += AT_ONCE) {
        const batch = ids.slice(i, i + AT_ONCE);
        // All of a batch or none of it: one failed thread fails the read, so a
        // partial inbox is never taken for the whole one.
        const parsed = await Promise.all(
          batch.map(async (id) =>
            parseThread(
              id,
              await askJson({
                who: "Gmail",
                what: "a thread",
                url: `${API}/threads/${id}?${THREAD_QUERY}`,
                headers,
              }),
              isOwnerEmail,
            ),
          ),
        );
        for (const row of parsed) if (row !== null) rows.push(row);
      }
      return rows;
    }),
});
