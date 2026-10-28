// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addLocalDays,
  dayHeading,
  eventsOn,
  localDayStart,
  timeLabel,
  weekDays,
  weekSpan,
  type CalendarEvent,
} from "./days";
import { peopleLabel } from "./people";

// Fixed instants, read in two zones. Node re-reads TZ when it is set, so the
// tests never depend on where the machine is.
const ALMATY = "Asia/Almaty"; // UTC+5, no daylight saving
const LA = "America/Los_Angeles"; // UTC-7 in October, UTC-8 after 1 November 2026
const HOUR = 60 * 60 * 1000;

const zone = (tz: string) => vi.stubEnv("TZ", tz);
afterEach(() => vi.unstubAllEnvs());

const timed = (eventId: string, startsAt: number, endsAt: number): CalendarEvent => ({
  kind: "event",
  eventId,
  title: "Made-up meeting",
  startsAt,
  endsAt,
  allDay: false,
  attendees: [],
  attendeeCount: 0,
  hasMeetingLink: false,
});
const allDay = (eventId: string, startDate: string, endDate: string): CalendarEvent => ({
  ...timed(eventId, Date.parse(`${startDate}T00:00:00Z`), Date.parse(`${endDate}T00:00:00Z`)),
  allDay: true,
  startDate,
  endDate,
});
const ids = (events: CalendarEvent[]) => events.map((event) => event.eventId);

describe("localDayStart", () => {
  // 2026-10-12 20:30 UTC is already the 13th in Almaty and still the 12th in Los Angeles.
  const AT = Date.UTC(2026, 9, 12, 20, 30);

  test("in Almaty", () => {
    zone(ALMATY);
    expect(new Date(localDayStart(AT)).toISOString()).toBe("2026-10-12T19:00:00.000Z");
  });

  test("in Los Angeles", () => {
    zone(LA);
    expect(new Date(localDayStart(AT)).toISOString()).toBe("2026-10-12T07:00:00.000Z");
  });

  test("midnight itself is the start of its own day", () => {
    zone(ALMATY);
    const midnight = Date.UTC(2026, 9, 12, 19, 0);
    expect(localDayStart(midnight)).toBe(midnight);
    expect(localDayStart(midnight - 1)).toBe(midnight - 24 * HOUR);
  });
});

describe("weekSpan and weekDays", () => {
  test("today and the seven days after it, from local midnight", () => {
    zone(ALMATY);
    const now = Date.UTC(2026, 9, 12, 6); // 11:00 in Almaty
    const span = weekSpan(now);
    expect(new Date(span.from).toISOString()).toBe("2026-10-11T19:00:00.000Z");
    expect(new Date(span.to).toISOString()).toBe("2026-10-19T19:00:00.000Z");
    expect(weekDays(now)).toHaveLength(8);
    expect(weekDays(now)[0]).toBe(span.from);
    expect(addLocalDays(weekDays(now)[7]!, 1)).toBe(span.to);
  });

  test("does not change from one minute to the next, only at local midnight", () => {
    zone(LA);
    const now = Date.UTC(2026, 9, 12, 18);
    expect(weekSpan(now + 60_000)).toEqual(weekSpan(now));
    expect(weekSpan(now + 13 * HOUR)).not.toEqual(weekSpan(now));
  });

  test("across the end of daylight saving the days are calendar days, not 24-hour blocks", () => {
    zone(LA);
    // Clocks go back on 1 November 2026, so that day is 25 hours long.
    const now = Date.UTC(2026, 9, 30, 18);
    const days = weekDays(now).map((day) => new Date(day).toISOString());
    expect(days[2]).toBe("2026-11-01T07:00:00.000Z");
    expect(days[3]).toBe("2026-11-02T08:00:00.000Z");
    const span = weekSpan(now);
    expect(span.to - span.from).toBe(8 * 24 * HOUR + HOUR);
    // Still inside what the query allows.
    expect(span.to - span.from).toBeLessThanOrEqual(10 * 24 * HOUR);
  });
});

describe("eventsOn", () => {
  // 02:00 UTC on the 13th: 07:00 on the 13th in Almaty, 19:00 on the 12th in Los Angeles.
  const meeting = timed("m", Date.UTC(2026, 9, 13, 2), Date.UTC(2026, 9, 13, 3));

  test("a timed meeting falls on the local day, which differs by zone", () => {
    zone(ALMATY);
    expect(ids(eventsOn([meeting], localDayStart(Date.UTC(2026, 9, 13, 6))))).toEqual(["m"]);
    expect(ids(eventsOn([meeting], localDayStart(Date.UTC(2026, 9, 12, 6))))).toEqual([]);

    zone(LA);
    const the12th = localDayStart(Date.UTC(2026, 9, 12, 20));
    expect(ids(eventsOn([meeting], the12th))).toEqual(["m"]);
    expect(ids(eventsOn([meeting], addLocalDays(the12th, 1)))).toEqual([]);
  });

  test("a meeting that runs past midnight is on both days", () => {
    zone(ALMATY);
    const day = localDayStart(Date.UTC(2026, 9, 12, 6));
    const late = timed("late", day + 23 * HOUR, day + 25 * HOUR);
    expect(ids(eventsOn([late], day))).toEqual(["late"]);
    expect(ids(eventsOn([late], addLocalDays(day, 1)))).toEqual(["late"]);
    expect(ids(eventsOn([late], addLocalDays(day, 2)))).toEqual([]);
  });

  test("a meeting ending exactly at midnight is not on the next day; one starting then is", () => {
    zone(ALMATY);
    const day = localDayStart(Date.UTC(2026, 9, 12, 6));
    const next = addLocalDays(day, 1);
    expect(ids(eventsOn([timed("ends", next - HOUR, next)], next))).toEqual([]);
    expect(ids(eventsOn([timed("starts", next, next + HOUR)], next))).toEqual(["starts"]);
    expect(ids(eventsOn([timed("starts", next, next + HOUR)], day))).toEqual([]);
    expect(ids(eventsOn([timed("instant", next, next)], next))).toEqual(["instant"]);
  });

  test("an all-day event belongs to the calendar's own dates in every zone, end exclusive", () => {
    const offsite = allDay("offsite", "2026-10-14", "2026-10-16");
    for (const tz of [ALMATY, LA]) {
      zone(tz);
      const the14th = new Date(2026, 9, 14).getTime();
      expect(ids(eventsOn([offsite], addLocalDays(the14th, -1))), tz).toEqual([]);
      expect(ids(eventsOn([offsite], the14th)), tz).toEqual(["offsite"]);
      expect(ids(eventsOn([offsite], addLocalDays(the14th, 1))), tz).toEqual(["offsite"]);
      expect(ids(eventsOn([offsite], addLocalDays(the14th, 2))), tz).toEqual([]);
    }
  });

  test("all-day events come first, then timed ones by start", () => {
    zone(ALMATY);
    const day = new Date(2026, 9, 14).getTime();
    const events = [
      timed("noon", day + 12 * HOUR, day + 13 * HOUR),
      allDay("offsite", "2026-10-14", "2026-10-15"),
      timed("nine", day + 9 * HOUR, day + 10 * HOUR),
    ];
    expect(ids(eventsOn(events, day))).toEqual(["offsite", "nine", "noon"]);
    // The list passed in is left as it was.
    expect(ids(events)).toEqual(["noon", "offsite", "nine"]);
  });
});

describe("labels", () => {
  test("timeLabel reads in the device's own zone", () => {
    const at = Date.UTC(2026, 9, 12, 15, 5);
    zone(ALMATY);
    expect(timeLabel(at)).toMatch(/^(8:05\s?PM|20:05)$/);
    zone(LA);
    expect(timeLabel(at)).toMatch(/^(8:05\s?AM|0?8:05)$/);
  });

  test("dayHeading: Today, Tomorrow, then the weekday and date", () => {
    zone(ALMATY);
    const now = Date.UTC(2026, 9, 12, 6);
    const [today, tomorrow, third] = weekDays(now);
    expect(dayHeading(today!, now)).toBe("Today");
    expect(dayHeading(tomorrow!, now)).toBe("Tomorrow");
    expect(dayHeading(third!, now)).toMatch(/Wednesday/);
    expect(dayHeading(third!, now)).toMatch(/14/);
  });
});

describe("peopleLabel", () => {
  const person = (name: string, address = "") => ({ name, address });

  test("names, or addresses where there is no name", () => {
    expect(peopleLabel([person("Ada Example"), person("", "bo@clinic.test")])).toBe(
      "Ada Example, bo@clinic.test",
    );
  });

  test("at most three are named, then a count", () => {
    const five = ["Ada", "Bo", "Cy", "Dee", "Eve"].map((n) => person(`${n} Example`));
    expect(peopleLabel(five)).toBe("Ada Example, Bo Example, Cy Example and 2 more");
    expect(peopleLabel(five.slice(0, 3))).toBe("Ada Example, Bo Example, Cy Example");
  });

  test("the count is of everyone, when the stored list was cut short", () => {
    expect(peopleLabel([person("Ada Example"), person("Bo Example")], 5)).toBe(
      "Ada Example, Bo Example and 3 more",
    );
  });

  test("nobody", () => {
    expect(peopleLabel([])).toBe("");
    expect(peopleLabel([], 4)).toBe("4 people");
    expect(peopleLabel([], 1)).toBe("1 person");
  });
});
