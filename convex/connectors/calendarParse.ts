// Pure: Calendar's events → meetings. The rules are the table in the plan's Task 4.

import { CAPS, cleanAddress, cleanRemote, type RecordOf } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const listShape = () =>
  new ConnectorError("Google Calendar's events were not in the expected shape.");
const eventShape = () => new ConnectorError("A calendar event was not in the expected shape.");

type When = Pick<RecordOf<"event">, "startsAt" | "endsAt" | "allDay" | "startDate" | "endDate">;

function parseWhen(start: unknown, end: unknown): When {
  if (!isRecord(start) || !isRecord(end)) throw eventShape();
  if (typeof start.date === "string" && typeof end.date === "string") {
    if (!DAY.test(start.date) || !DAY.test(end.date)) throw eventShape();
    const startsAt = Date.parse(`${start.date}T00:00:00Z`);
    const endsAt = Date.parse(`${end.date}T00:00:00Z`);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw eventShape();
    return { startsAt, endsAt, allDay: true, startDate: start.date, endDate: end.date };
  }
  const startsAt = typeof start.dateTime === "string" ? Date.parse(start.dateTime) : Number.NaN;
  const endsAt = typeof end.dateTime === "string" ? Date.parse(end.dateTime) : Number.NaN;
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw eventShape();
  return { startsAt, endsAt, allDay: false };
}

function parseEvent(event: Record<string, unknown>): RecordOf<"event"> | null {
  if (event.status === "cancelled") return null;
  if (event.eventType !== undefined && event.eventType !== "default") return null;
  const attendees = Array.isArray(event.attendees) ? event.attendees.filter(isRecord) : [];
  if (attendees.some((a) => a.self === true && a.responseStatus === "declined")) return null;
  if (typeof event.id !== "string" || event.id === "") throw eventShape();

  const hidden = event.visibility === "private" || event.visibility === "confidential";
  const others = hidden
    ? []
    : attendees
        .filter((a) => a.self !== true && a.resource !== true)
        .map((a) => ({
          name: cleanRemote(a.displayName, CAPS.name),
          address: cleanAddress(a.email),
        }))
        .filter((person) => person.name !== "" || person.address !== "");
  const entryPoints = isRecord(event.conferenceData) ? event.conferenceData.entryPoints : undefined;

  return {
    kind: "event",
    eventId: event.id,
    title: hidden ? "Busy" : cleanRemote(event.summary, CAPS.title) || "(no title)",
    ...parseWhen(event.start, event.end),
    attendees: others.slice(0, CAPS.people),
    attendeeCount: others.length,
    hasMeetingLink: Array.isArray(entryPoints) && entryPoints.length > 0,
  };
}

export function parseEvents(json: unknown): { rows: RecordOf<"event">[]; next: string | null } {
  if (!isRecord(json) || json.kind !== "calendar#events") throw listShape();
  const items = json.items ?? [];
  if (!Array.isArray(items)) throw listShape();
  const rows: RecordOf<"event">[] = [];
  for (const item of items) {
    if (!isRecord(item)) throw eventShape();
    const row = parseEvent(item);
    if (row !== null) rows.push(row);
  }
  const next = typeof json.nextPageToken === "string" && json.nextPageToken !== "" ? json.nextPageToken : null;
  return { rows, next };
}
