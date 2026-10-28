import { describe, expect, test } from "vitest";
import { PROPOSAL_KINDS } from "./agents";
import {
  EVENTS_PER_BOT_PER_HOUR,
  EVENT_TITLE_LIMIT,
  MAX_DELIVERY_ATTEMPTS,
  MIN_SECRET_LENGTH,
  PROPOSAL_EVENT_TITLES,
  RETRY_BACKOFF_MS,
  assigneeProfileId,
  botCoversCompany,
  botEventPayload,
  countEvent,
  deliveryBody,
  eventTitle,
  handoffReceivingBot,
  isBlockedHost,
  mayReceiveEvents,
  signBody,
  taskAssigneeBot,
  webhookConfigured,
  webhookTarget,
  webhookUrl,
} from "./botEvents";

const AT = Date.UTC(2026, 9, 14, 6);
const DELIVERY = "5d1f3c3e-0000-4000-8000-000000000001";
const SECRET = "s".repeat(MIN_SECRET_LENGTH);
const OLD_SECRET = "o".repeat(MIN_SECRET_LENGTH);

const task = (over: Record<string, unknown> = {}) =>
  botEventPayload({
    event: "task.assigned",
    company: "us",
    agent: "growth",
    id: "task-1",
    title: "Call the sample clinic",
    deliveryId: DELIVERY,
    at: AT,
    ...over,
  });

describe("botEventPayload", () => {
  test("a task event is exactly those fields, and a decision is not added", () => {
    const event = task({ decision: "approved" });
    expect(event).toEqual({
      event: "task.assigned",
      company: "us",
      agent: "growth",
      id: "task-1",
      title: "Call the sample clinic",
      deliveryId: DELIVERY,
      at: AT,
    });
    expect(Object.keys(deliveryBody(event!))).toEqual(["deliveryId", "event", "company", "agent", "id", "title", "at"]);
  });

  test("a title is one line, cut at 140 characters", () => {
    expect(eventTitle("Hello\n\nworld\tthere")).toBe("Hello world there");
    const long = "a".repeat(180);
    const title = task({ title: long })!.title;
    expect(title.length).toBe(EVENT_TITLE_LIMIT);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("a".repeat(EVENT_TITLE_LIMIT - 1))).toBe(true);
  });

  test("a proposal carries the decision, and only a proposal does", () => {
    const decided = botEventPayload({
      event: "proposal.decided",
      company: "kz",
      agent: "Growth",
      id: "proposal-1",
      title: "New pricing page",
      decision: "dismissed",
      deliveryId: DELIVERY,
      at: AT,
    });
    expect(decided).toMatchObject({ event: "proposal.decided", agent: "growth", decision: "dismissed", company: "kz" });
    expect(Object.keys(deliveryBody(decided!)).sort()).toEqual(
      ["agent", "at", "company", "decision", "deliveryId", "event", "id", "title"].sort(),
    );
    expect(
      botEventPayload({
        event: "proposal.decided",
        company: "us",
        agent: "growth",
        id: "proposal-1",
        title: "New pricing page",
        deliveryId: DELIVERY,
        at: AT,
      }),
    ).toBeNull();
  });

  test("a person, a shared task, a Mac agent, one of the bare four and an empty title are not sent", () => {
    expect(task({ company: undefined })).toBeNull();
    expect(task({ agent: "ada@example.com" })).toBeNull();
    expect(task({ agent: null })).toBeNull();
    expect(task({ agent: "mac:engineering" })).toBeNull();
    // `sales` has no profile: it is the Mac agent alone, never a receiver.
    expect(task({ agent: "sales" })).toBeNull();
    expect(task({ title: "  \n  " })).toBeNull();
    expect(task({ id: "" })).toBeNull();
    expect(task({ deliveryId: "" })).toBeNull();
    // An external profile is named by its profile id, as `whoami` gives it.
    expect(task({ agent: "chief_of_staff" })).toMatchObject({ agent: "chief_of_staff" });
  });
});

describe("who the event is for", () => {
  test("a task assignee is a bot profile, never an address and never one of the bare four", () => {
    expect(taskAssigneeBot(" Growth ")).toBe("growth");
    expect(taskAssigneeBot("ada@example.com")).toBeNull();
    expect(taskAssigneeBot("")).toBeNull();
    for (const bare of ["sales", "chief_of_staff", "engineering", "finance"]) {
      expect(taskAssigneeBot(bare)).toBeNull();
    }
    // An external profile is spelled as a handoff spells it.
    expect(taskAssigneeBot("bot:engineering")).toBe("bot:engineering");
    expect(taskAssigneeBot("BOT:Chief_of_staff")).toBe("bot:chief_of_staff");
    expect(taskAssigneeBot("bot:sales")).toBeNull();
    expect(taskAssigneeBot("bot:growth")).toBe("growth");
    expect(taskAssigneeBot("mac:engineering")).toBeNull();
    expect(assigneeProfileId("bot:engineering")).toBe("engineering");
    expect(assigneeProfileId("growth")).toBe("growth");
    expect(assigneeProfileId("sales")).toBeNull();
    expect(assigneeProfileId(undefined)).toBeNull();
  });

  test("a handoff key folds to the profile id, and a person, a Mac agent or a bare four does not", () => {
    expect(handoffReceivingBot("growth")).toBe("growth");
    expect(handoffReceivingBot("bot:engineering")).toBe("engineering");
    expect(handoffReceivingBot("bot:FINANCE")).toBe("finance");
    expect(handoffReceivingBot("mac:engineering")).toBeNull();
    expect(handoffReceivingBot("engineering")).toBeNull();
    expect(handoffReceivingBot("sales")).toBeNull();
    expect(handoffReceivingBot("@ada@example.com", "person")).toBeNull();
    expect(handoffReceivingBot("ada@example.com")).toBeNull();
  });

  test("a bot covers a task when its profile says so", () => {
    expect(botCoversCompany(undefined, "kz")).toBe(true);
    expect(botCoversCompany("both", "us")).toBe(true);
    expect(botCoversCompany("us", "us")).toBe(true);
    expect(botCoversCompany("us", "kz")).toBe(false);
    expect(botCoversCompany("us", undefined)).toBe(true);
  });

  test("only a switched-on profile that reads or writes the board, on that company, receives", () => {
    const board = (level: "read" | "write") => [{ area: "board" as const, level }];
    expect(mayReceiveEvents({ enabled: true, permissions: board("write"), company: undefined }, "us")).toBe(true);
    expect(mayReceiveEvents({ enabled: true, permissions: board("read"), company: "us" }, "us")).toBe(true);
    expect(mayReceiveEvents({ enabled: false, permissions: board("write"), company: "us" }, "us")).toBe(false);
    expect(mayReceiveEvents({ enabled: true, permissions: [{ area: "memory", level: "write" }], company: "us" }, "us")).toBe(
      false,
    );
    expect(mayReceiveEvents({ enabled: true, permissions: board("write"), company: "us" }, "kz")).toBe(false);
    expect(mayReceiveEvents(null, "us")).toBe(false);
  });
});

describe("the webhook target", () => {
  test("the URL is https on a public host, never with a secret in it", () => {
    expect(webhookConfigured(undefined)).toBe(false);
    expect(webhookConfigured("  ")).toBe(false);
    expect(webhookConfigured("https://example.com/hook")).toBe(true);
    expect(webhookUrl("https://example.com/hook", false)).toBe("https://example.com/hook");
    expect(webhookUrl("http://example.com/hook", false)).toBeNull();
    expect(webhookUrl("https://user:pass@example.com/hook", false)).toBeNull();
    expect(webhookUrl("not a url", false)).toBeNull();
  });

  test("loopback, private, link-local and metadata addresses are refused", () => {
    for (const url of [
      "https://localhost/hook",
      "https://api.localhost/hook",
      "https://127.0.0.1/hook",
      "https://127.9.9.9/hook",
      "https://0x7f.0.0.1/hook",
      "https://2130706433/hook",
      "https://10.1.2.3/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.255/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fc00::1]/hook",
      "https://[fd12:3456::1]/hook",
      "https://[fe80::1]/hook",
      "https://[febf::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:10.0.0.1]/hook",
      "https://metadata.google.internal/computeMetadata/v1",
    ]) {
      expect([url, webhookUrl(url, false)]).toEqual([url, null]);
    }
    expect(isBlockedHost("172.15.0.1")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false);
    expect(isBlockedHost("[fec0::1]")).toBe(false);
    expect(isBlockedHost("hooks.example.com")).toBe(false);
  });

  test("http to this machine only on a local development deployment", () => {
    expect(webhookUrl("http://localhost:3100/hook", true)).toBe("http://localhost:3100/hook");
    expect(webhookUrl("http://127.0.0.1/hook", true)).toBe("http://127.0.0.1/hook");
    expect(webhookUrl("http://localhost:3100/hook", false)).toBeNull();
    expect(webhookUrl("http://10.0.0.1/hook", true)).toBeNull();
    expect(webhookUrl("http://example.com/hook", true)).toBeNull();
  });

  test("unset does nothing, and a bad URL or a missing or short secret is unusable", () => {
    expect(webhookTarget({ url: undefined, secret: SECRET, dev: false })).toEqual({ kind: "unset" });
    expect(webhookTarget({ url: "  ", secret: SECRET, dev: false })).toEqual({ kind: "unset" });
    expect(webhookTarget({ url: "http://example.com/hook", secret: SECRET, dev: false })).toEqual({ kind: "unusable" });
    expect(webhookTarget({ url: "https://example.com/hook", secret: undefined, dev: false })).toEqual({ kind: "unusable" });
    expect(webhookTarget({ url: "https://example.com/hook", secret: "short", dev: false })).toEqual({ kind: "unusable" });
    expect(webhookTarget({ url: "https://example.com/hook", secret: SECRET, dev: false })).toEqual({
      kind: "ready",
      url: "https://example.com/hook",
      secret: SECRET,
      previous: null,
    });
    expect(
      webhookTarget({ url: "https://example.com/hook", secret: SECRET, previous: OLD_SECRET, dev: false }),
    ).toMatchObject({ kind: "ready", previous: OLD_SECRET });
    // A previous secret that is unusable is left out, never sent half-formed.
    expect(webhookTarget({ url: "https://example.com/hook", secret: SECRET, previous: "x", dev: false })).toMatchObject({
      previous: null,
    });
  });

  test("the signature is hex HMAC-SHA256 of `timestamp.body`", async () => {
    // Computed independently: printf '1700000000.{"a":1}' | openssl dgst -sha256 -hmac key
    expect(await signBody("key", "1700000000", '{"a":1}')).toBe(
      "a438e398bfafc57e4396bb7fc2304422f0f768e965d073ca313cb52e22e6ad03",
    );
    const one = await signBody(SECRET, "1700000000", '{"a":1}');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await signBody(SECRET, "1700000001", '{"a":1}')).not.toBe(one);
    expect(await signBody(SECRET, "1700000000", '{"a":2}')).not.toBe(one);
    expect(await signBody(OLD_SECRET, "1700000000", '{"a":1}')).not.toBe(one);
  });
});

describe("the hourly limit a bot", () => {
  const HOUR = 60 * 60 * 1000;
  test("sixty a bot an hour are sent, the rest are counted and not sent, and the next hour starts again", () => {
    let row: { windowStart: number; sent: number; dropped: number } | null = null;
    let sent = 0;
    for (let i = 0; i < EVENTS_PER_BOT_PER_HOUR + 5; i++) {
      const next = countEvent(row, AT + i);
      if (next.send) sent += 1;
      row = next.row;
    }
    expect(sent).toBe(EVENTS_PER_BOT_PER_HOUR);
    expect(row).toMatchObject({ sent: EVENTS_PER_BOT_PER_HOUR, dropped: 5 });
    const later = countEvent(row, AT + HOUR + 1);
    expect(later.send).toBe(true);
    expect(later.row).toMatchObject({ sent: 1, dropped: 0 });
  });
});

describe("retries and proposal titles", () => {
  test("four tries, then give up", () => {
    expect(RETRY_BACKOFF_MS).toEqual([1_000, 5_000, 30_000]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(4);
  });

  test("every proposal kind has a title that is not the payload", () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(PROPOSAL_EVENT_TITLES[kind].length).toBeGreaterThan(0);
    }
  });
});
