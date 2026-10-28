import { describe, expect, test } from "vitest";
import { ConnectorError } from "./errors";
import { HELD, answer, transcript } from "./fireflies.fixtures";
import { parseMeetings } from "./firefliesParse";

const one = (over: Record<string, unknown>) => parseMeetings(answer([transcript(over)]))[0];

/** What was thrown, so its class and its message can both be checked. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a throw.");
}

const SHAPE = "Fireflies' meetings were not in the expected shape.";

describe("parseMeetings", () => {
  test("one meeting, in full", () => {
    expect(parseMeetings(answer([transcript()]))).toEqual([
      {
        kind: "meeting",
        meetingId: "meet-1",
        title: "Made-up meeting",
        heldAt: HELD,
        durationMinutes: 31,
        participants: [
          { name: "Ada Example", address: "ada@example-fund.test" },
          { name: "", address: "bo@clinic.test" },
        ],
        overview: "A made-up summary.",
        actionItems: ["Send the made-up deck", "Book a made-up follow-up"],
      },
    ]);
  });

  test("two transcripts are two records: the date is milliseconds, the duration whole minutes", () => {
    const rows = parseMeetings(
      answer([transcript(), transcript({ id: "meet-2", date: HELD + 1000, duration: 59.6 })]),
    );
    expect(rows.map((r) => [r.meetingId, r.heldAt, r.durationMinutes])).toEqual([
      ["meet-1", HELD, 31],
      ["meet-2", HELD + 1000, 60],
    ]);
  });

  test("never keeps a transcript, even when Fireflies sends one", () => {
    const row = one({
      sentences: [{ text: "REMOTE-TRANSCRIPT", speaker_name: "REMOTE-SPEAKER" }],
      transcript_url: "https://app.example.test/REMOTE-LINK",
      audio_url: "https://cdn.example.test/REMOTE-AUDIO",
    });
    expect(JSON.stringify(row)).not.toContain("REMOTE-");
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "actionItems",
        "durationMinutes",
        "heldAt",
        "kind",
        "meetingId",
        "overview",
        "participants",
        "title",
      ].sort(),
    );
  });

  test("the short summary is the overview; failing that, the long one; failing both, nothing", () => {
    expect(one({})?.overview).toBe("A made-up summary.");
    expect(one({ summary: { short_summary: "", overview: "A longer made-up overview." } })?.overview).toBe(
      "A longer made-up overview.",
    );
    expect(one({ summary: { short_summary: null, overview: "  " } })?.overview).toBe("");
  });

  test("an overview is one line of at most 1,200 characters", () => {
    const overview = one({ summary: { short_summary: `Made-up\n\n${"x".repeat(3000)}` } })?.overview ?? "";
    expect(overview).toHaveLength(1200);
    expect(overview).not.toContain("\n");
  });

  test("action items as one string with a line each, or as a list: the same items either way", () => {
    const expected = ["Send the made-up deck", "Book a made-up follow-up"];
    const text = one({ summary: { action_items: "Send the made-up deck\r\n\n  \nBook a made-up follow-up\n" } });
    const list = one({ summary: { action_items: ["Send the made-up deck", "", "  ", "Book a made-up follow-up", 7, null] } });
    expect(text?.actionItems).toEqual(expected);
    expect(list?.actionItems).toEqual(expected);
  });

  test("at most 20 action items, each at most 300 characters", () => {
    const many = Array.from({ length: 35 }, (_, n) => `Made-up item ${n} ${"x".repeat(500)}`);
    const items = one({ summary: { action_items: many } })?.actionItems ?? [];
    expect(items).toHaveLength(20);
    expect(items.every((item) => item.length === 300)).toBe(true);
    expect(one({ summary: { action_items: many.join("\n") } })?.actionItems).toHaveLength(20);
  });

  test.each([[null], [undefined], ["not an object"]])(
    "a summary of %j (still processing): the meeting is kept, with nothing in it",
    (summary) => {
      expect(one({ summary })).toMatchObject({
        meetingId: "meet-1",
        overview: "",
        actionItems: [],
      });
    },
  );

  test("attendees: cleaned; one with neither a name nor an address is dropped; at most 30", () => {
    expect(
      one({
        meeting_attendees: [
          { displayName: "  Ada\nExample ", email: " ADA@example-fund.test " },
          { displayName: "", email: "not an address" },
          { displayName: "Cy Example", email: null },
          "not an object",
        ],
      })?.participants,
    ).toEqual([
      { name: "Ada Example", address: "ada@example-fund.test" },
      { name: "Cy Example", address: "" },
    ]);
    const many = Array.from({ length: 45 }, (_, n) => ({ email: `person-${n}@example.test` }));
    expect(one({ meeting_attendees: many })?.participants).toHaveLength(30);
    expect(one({ meeting_attendees: null })?.participants).toEqual([]);
  });

  test("no title", () => {
    expect(one({ title: null })?.title).toBe("(no title)");
    expect(one({ title: "" })?.title).toBe("(no title)");
  });

  test.each([
    [undefined, 0],
    [null, 0],
    [-5, 0],
    ["45", 0],
    [0, 0],
    [1440, 1440],
    [5000, 1440],
  ])("a duration of %j is %i minutes", (duration, minutes) => {
    expect(one({ duration })?.durationMinutes).toBe(minutes);
  });

  test("no meetings", () => {
    expect(parseMeetings(answer([]))).toEqual([]);
  });
});

describe("parseMeetings: what fails the read", () => {
  test.each([
    ["no id", { id: undefined }],
    ["an empty id", { id: "" }],
    ["an id that is not text", { id: 7 }],
    ["a date that is not a number", { date: "2026-10-10" }],
    ["no date", { date: undefined }],
    ["a date that is not finite", { date: Number.NaN }],
  ])("a transcript with %s", (_name, over) => {
    const error = thrown(() => one(over));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(SHAPE);
  });

  test("a transcript that is not an object", () => {
    expect(thrown(() => parseMeetings(answer(["x"]))).message).toBe(SHAPE);
  });

  test.each([
    ["null", null],
    ["data with nothing in it", { data: {} }],
    ["no data", {}],
    ["transcripts that is not a list", { data: { transcripts: "x" } }],
  ])("%s", (_name, json) => {
    const error = thrown(() => parseMeetings(json));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(SHAPE);
  });

  test.each([
    ["alone", { errors: [{ message: "REMOTE-TEXT" }] }],
    ["beside data", { ...answer([transcript()]), errors: [{ message: "REMOTE-TEXT" }] }],
  ])("a GraphQL errors array %s is reported in our words, never Fireflies'", (_name, json) => {
    const error = thrown(() => parseMeetings(json));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Fireflies reported an error for meetings.");
  });

  test("no thrown message contains anything Fireflies sent", () => {
    const error = thrown(() => one({ title: "REMOTE-TITLE", date: "REMOTE-DATE" }));
    expect(error.message).toBe(SHAPE);
    expect(error.message).not.toContain("REMOTE");
  });
});
