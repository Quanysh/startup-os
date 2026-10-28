import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MAC_CLIENT, NOW, answer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules } from "./test.setup";

// The tools for questionnaires, the answer bank, agreements and evidence
// (convex/lib/mcpTools.ts): written through the page's own functions, marked
// with the calling client, and read back with `compliance_evidence`.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 2026-10-14
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world(scope: "read" | "act" = "act") {
  const t = convexTest(schema, modules);
  const { owner, token } = await ownerWithToken(t, scope);
  return { t, owner, token };
}

describe("compliance_evidence and the four upserts", () => {
  test("a questionnaire written over MCP is the page's, marked with the client", async () => {
    const { t, owner, token } = await world();
    const saved = await answer(t, token, "questionnaire_upsert", {
      requester: " Initech Health ",
      company: "us",
      dueOn: "2026-10-30",
      link: "https://docs.example.com/sq",
    });
    expect(saved.saved).toBe(true);
    const [row] = await owner.query(api.evidence.questionnaires, {});
    expect(row).toMatchObject({ requester: "Initech Health", status: "todo", changedBy: MAC_CLIENT });
    // The same row, changed by id: only what is sent.
    await answer(t, token, "questionnaire_upsert", { id: saved.id, status: "sent" });
    expect((await owner.query(api.evidence.questionnaires, {}))[0]).toMatchObject({
      status: "sent",
      dueOn: "2026-10-30",
    });
    const read = await answer(t, token, "compliance_evidence", { section: "questionnaires" });
    expect((read.questionnaires as unknown[]).length).toBe(1);
    expect(read.answers).toEqual([]);
  });

  test("the page's checks hold: an http link, a bad day and a missing company are refused", async () => {
    const { t, owner, token } = await world();
    const refused = async (args: object) => {
      const reply = await call(t, token, "questionnaire_upsert", args);
      expect(reply.isError).toBe(true);
      return reply.said;
    };
    expect(await refused({ requester: "X", company: "us", link: "http://x.example.com" })).toMatch(/https/);
    expect(await refused({ requester: "X", company: "us", dueOn: "2026-02-31" })).toMatch(/not a date/);
    expect(await refused({ requester: "X" })).toMatch(/needs a requester and a company/);
    expect(await refused({ requester: "X", company: "us", surprise: 1 })).toBeTruthy();
    expect(await owner.query(api.evidence.questionnaires, {})).toEqual([]);
  });

  test("the answer bank: tags cleaned, company filter, text search", async () => {
    const { t, token } = await world();
    await answer(t, token, "answer_bank_upsert", {
      question: "Do you encrypt data at rest?",
      answer: "Yes. AES-256.",
      tags: ["Encryption", "encryption", "SOC2"],
      lastReviewedOn: "2026-10-01",
    });
    await answer(t, token, "answer_bank_upsert", { question: "Where is data stored in Kazakhstan?", answer: "In Astana.", company: "kz" });
    const all = await answer(t, token, "compliance_evidence", { section: "answers" });
    expect((all.answers as { tags: string[] }[]).find((a) => a.tags.length)!.tags).toEqual(["encryption", "soc2"]);
    const us = await answer(t, token, "compliance_evidence", { section: "answers", company: "us" });
    expect((us.answers as { question: string }[]).map((a) => a.question)).toEqual(["Do you encrypt data at rest?"]);
    const found = await answer(t, token, "compliance_evidence", { section: "answers", query: "astana" });
    expect((found.answers as unknown[]).length).toBe(1);
  });

  test("agreements: expiring filter, state and days read against the caller's day", async () => {
    const { t, token } = await world();
    const add = (vendor: string, expiresOn: string, status = "active") =>
      answer(t, token, "vendor_agreement_upsert", { vendor, type: "baa", company: "us", expiresOn, status });
    await add("Soon", "2026-11-20");
    await add("Late", "2027-08-01");
    await add("Gone", "2026-09-01");
    await add("Ended", "2026-11-01", "ended");
    const soon = await answer(t, token, "compliance_evidence", { section: "agreements", expiringWithinDays: 60 });
    const rows = soon.agreements as { vendor: string; state: string; days: number }[];
    expect(rows.map((r) => [r.vendor, r.state])).toEqual([
      ["Gone", "expired"],
      ["Soon", "expiring"],
    ]);
    // `today` moves the day it is judged by (within a day of the server's).
    const next = await answer(t, token, "compliance_evidence", { section: "agreements", today: "2026-10-15", query: "soon" });
    expect((next.agreements as { days: number }[])[0]!.days).toBe(36);
  });

  test("evidence: a control is made, items added and changed, coverage counted", async () => {
    const { t, owner, token } = await world();
    const missingTitle = await call(t, token, "evidence_upsert", { framework: "soc2", controlId: "CC6.1" });
    expect(missingTitle.said).toMatch(/needs a control title/);

    const first = await answer(t, token, "evidence_upsert", {
      framework: "soc2",
      controlId: "CC6.1",
      controlTitle: "Logical access",
      item: { title: "Quarterly access review", link: "https://drive.example.com/a", validUntil: "2026-12-31" },
    });
    await answer(t, token, "evidence_upsert", {
      framework: "soc2",
      controlId: "CC6.2",
      controlTitle: "Provisioning",
      item: { title: "Offboarding checklist", link: "https://drive.example.com/b", validUntil: "2026-10-01" },
    });
    await answer(t, token, "evidence_upsert", { framework: "hipaa", controlId: "164.308", controlTitle: "Risk analysis" });

    const read = await answer(t, token, "compliance_evidence", { section: "evidence" });
    expect(read.coverage).toEqual([
      { framework: "hipaa", total: 1, withEvidence: 0 },
      { framework: "soc2", total: 2, withEvidence: 1 },
      { framework: "iso27001", total: 0, withEvidence: 0 },
    ]);
    const controls = read.controls as { controlId: string; items: { effectiveStatus: string; changedBy: string }[] }[];
    expect(controls.find((c) => c.controlId === "CC6.2")!.items[0]).toMatchObject({
      effectiveStatus: "expired",
      changedBy: MAC_CLIENT,
    });

    // Changing the item by id; the control is found by framework and id, not duplicated.
    await answer(t, token, "evidence_upsert", {
      framework: "soc2",
      controlId: "CC6.1",
      item: { id: (await owner.query(api.evidence.controls, {}))[1]!.items[0]!.id, status: "accepted" },
    });
    expect(await owner.query(api.evidence.controls, {})).toHaveLength(3);
    expect(first.saved).toBe(true);

    const expired = await answer(t, token, "compliance_evidence", { section: "evidence", status: "expired", framework: "soc2" });
    expect((expired.controls as { controlId: string }[]).map((c) => c.controlId)).toEqual(["CC6.2"]);
  });

  test("an agreement ending within 60 days is on the overview's attention list, counted and not named", async () => {
    const { t, token } = await world();
    await answer(t, token, "vendor_agreement_upsert", {
      vendor: "SECRET Vendor",
      type: "dpa",
      company: "kz",
      status: "active",
      expiresOn: "2026-11-30",
    });
    const overview = await answer(t, token, "overview");
    const items = overview.items as { id: string; title: string }[];
    expect(items.find((i) => i.id === "agreements:expiring")!.title).toBe(
      "1 vendor agreement ending in the next 60 days",
    );
    expect(JSON.stringify(overview)).not.toContain("SECRET");
    const startup = await answer(t, token, "overview", { company: "us" });
    expect((startup.items as { id: string }[]).some((i) => i.id.startsWith("agreements:"))).toBe(false);
  });

  test("a read-only token cannot write", async () => {
    const { t, token } = await world("read");
    const reply = await call(t, token, "evidence_upsert", { framework: "soc2", controlId: "x", controlTitle: "y" });
    expect(reply.isError ?? reply.error).toBeTruthy();
    expect((await answer(t, token, "compliance_evidence")).coverage).toBeDefined();
  });

  test("no secret or document body has a field to live in", async () => {
    const { t, token } = await world();
    const reply = await call(t, token, "evidence_upsert", {
      framework: "soc2",
      controlId: "CC1.1",
      controlTitle: "x",
      item: { title: "y", content: "BEGIN PRIVATE KEY" },
    });
    expect(reply.isError ?? reply.error).toBeTruthy();
  });
});
