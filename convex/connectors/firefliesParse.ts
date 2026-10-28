// Pure: Fireflies' transcripts → meeting notes. A summary and its action
// items; the transcript itself is never requested.

import { CAPS, cleanAddress, cleanRemote, type RecordOf } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shape = () => new ConnectorError("Fireflies' meetings were not in the expected shape.");

/** One string with a line per item, or a list: the docs do not say which. */
function actionItems(value: unknown): string[] {
  const lines = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  return lines
    .map((line) => cleanRemote(line, CAPS.actionItem))
    .filter((line) => line !== "")
    .slice(0, CAPS.actionItems);
}

function parseMeeting(item: unknown): RecordOf<"meeting"> {
  if (!isRecord(item) || typeof item.id !== "string" || item.id === "") throw shape();
  if (typeof item.date !== "number" || !Number.isFinite(item.date)) throw shape();
  const summary = isRecord(item.summary) ? item.summary : {};
  const attendees = Array.isArray(item.meeting_attendees) ? item.meeting_attendees : [];
  const minutes = typeof item.duration === "number" && item.duration > 0 ? item.duration : 0;
  return {
    kind: "meeting",
    meetingId: item.id,
    title: cleanRemote(item.title, CAPS.title) || "(no title)",
    heldAt: item.date,
    durationMinutes: Math.min(Math.round(minutes), 1440),
    participants: attendees
      .filter(isRecord)
      .map((a) => ({ name: cleanRemote(a.displayName, CAPS.name), address: cleanAddress(a.email) }))
      .filter((person) => person.name !== "" || person.address !== "")
      .slice(0, CAPS.people),
    overview:
      cleanRemote(summary.short_summary, CAPS.overview) || cleanRemote(summary.overview, CAPS.overview),
    actionItems: actionItems(summary.action_items),
  };
}

export function parseMeetings(json: unknown): RecordOf<"meeting">[] {
  if (!isRecord(json)) throw shape();
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new ConnectorError("Fireflies reported an error for meetings.");
  }
  if (!isRecord(json.data) || !Array.isArray(json.data.transcripts)) throw shape();
  return json.data.transcripts.map(parseMeeting);
}
