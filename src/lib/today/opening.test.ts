import { describe, expect, test } from "vitest";
import { dayAhead, openingLine, openingText, type OpeningInput } from "./opening";

// Local noon on 2026-10-16, so "today" is the 16th in any timezone.
const NOW = new Date(2026, 9, 16, 12).getTime();
const HOUR = 60 * 60 * 1000;
const at = (hour: number, minute = 0) => new Date(2026, 9, 16, hour, minute).getTime();
const time = (when: number) => {
  const d = new Date(when);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const base: OpeningInput = {
  runway: null,
  needs: 0,
  day: null,
  today: "2026-10-16",
};

describe("the opening line", () => {
  test("the owner: runway, then what needs them and their first meeting", () => {
    const line = openingLine({
      ...base,
      runway: { subject: "Group cash", runOut: { kind: "date", date: "2026-11-08", days: 23 } },
      needs: 3,
      day: { kind: "first", time: "11:00" },
    });
    expect(openingText(line)).toBe(
      "Group cash runs out around 8 Nov. 3 things need you; your first meeting is at 11:00.",
    );
    // Each clause leads to where it is acted on.
    expect(line.filter((part) => part.href !== undefined).map((part) => [part.text, part.href])).toEqual([
      ["Group cash runs out around 8 Nov", "/finance"],
      ["3 things need you", "#needs-you"],
      ["your first meeting is at 11:00", "#your-day"],
    ]);
  });

  test("a runway past two months is a month, and one past 24 months says so", () => {
    expect(
      openingText(
        openingLine({ ...base, runway: { subject: "Cash", runOut: { kind: "date", date: "2027-06-20", days: 247 } } }),
      ),
    ).toBe("Cash runs out in Jun 2027. Nothing needs you.");
    expect(openingText(openingLine({ ...base, runway: { subject: "Startup's cash", runOut: { kind: "beyond" } } }))).toBe(
      "Startup's cash lasts beyond 24 months. Nothing needs you.",
    );
  });

  test("a teammate without finance: no runway clause, never a guess", () => {
    expect(openingText(openingLine({ ...base, needs: 1, day: { kind: "next", time: "14:30" } }))).toBe(
      "1 thing needs you; your next meeting is at 14:30.",
    );
  });

  test("a missing runway is left out, not said as zero", () => {
    const line = openingLine({ ...base, runway: null, needs: 2 });
    expect(openingText(line)).toBe("2 things need you.");
    expect(openingText(line)).not.toMatch(/runs out|0 months/);
  });

  test("nothing needing the viewer is one calm clause", () => {
    expect(openingText(openingLine({ ...base, needs: 0, day: { kind: "none" } }))).toBe(
      "Nothing needs you; no meetings today.",
    );
    expect(openingText(openingLine({ ...base, needs: 0, day: { kind: "done" } }))).toBe(
      "Nothing needs you; no more meetings today.",
    );
  });

  test("a count still loading leaves the clause out", () => {
    expect(openingLine({ ...base, needs: null })).toEqual([]);
    expect(openingText(openingLine({ ...base, needs: null, day: { kind: "first", time: "09:00" } }))).toBe(
      "Your first meeting is at 09:00.",
    );
  });
});

describe("the day ahead, from the calendar", () => {
  const event = (startsAt: number, patch: Record<string, unknown> = {}) => ({
    eventId: `e${startsAt}`,
    title: "Made-up meeting",
    startsAt,
    endsAt: startsAt + HOUR,
    allDay: false,
    ...patch,
  });

  test("before anything has started: the first meeting", () => {
    expect(dayAhead([event(at(15)), event(at(13, 30))], at(8), time)).toEqual({ kind: "first", time: "13:30" });
  });

  test("once one has started: the next one", () => {
    expect(dayAhead([event(at(9)), event(at(15))], NOW, time)).toEqual({ kind: "next", time: "15:00" });
  });

  test("with all of today's behind: none left; with none today at all: none", () => {
    expect(dayAhead([event(at(9))], at(18), time)).toEqual({ kind: "done" });
    expect(dayAhead([event(at(9) + 24 * HOUR)], NOW, time)).toEqual({ kind: "none" });
    expect(dayAhead([], NOW, time)).toEqual({ kind: "none" });
  });

  test("an all-day event is no meeting with a time", () => {
    expect(dayAhead([event(at(0), { allDay: true, endsAt: at(0) + 24 * HOUR })], at(8), time)).toEqual({
      kind: "none",
    });
  });
});
