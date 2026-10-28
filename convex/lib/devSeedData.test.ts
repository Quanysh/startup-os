import { describe, expect, test } from "vitest";
import { freshness } from "../../src/lib/freshness";
import { SOURCES } from "../connectors/manifest";
import { LOCAL_DOMAIN, LOCAL_OWNER_EMAIL, LOCAL_ROLES } from "./devLocal";
import { addMonths, bucketOf, looksLikeAccountNumber } from "./costs";
import { timeSharesProblem } from "./payroll";
import { cleanIntelEdit } from "./dealIntel";
import { cleanPreset } from "./roleRules";
import {
  SEED_COSTS,
  SEED_DEAL_INTEL,
  seedCostMonth,
  SEED_PAY_LINES,
  SEED_PAY_PEOPLE,
  SEED_PEOPLE,
  SEED_ROLES,
  TODAY_TEAMMATE,
  seedAreasOf,
  SEED_TARGETS,
  SEED_NOTIFICATIONS,
  SEED_TASKS,
  SEED_WORK_TOOL_SETTINGS,
  closedMonths,
  emailOf,
  localName,
  seedCustomers,
  seedCustomerUsage,
  seedDeals,
  seedGoals,
  seedInvestors,
  seedMirror,
  seedObligations,
  seedPlan,
  seedShared,
  seedSnapshots,
  seedSourceStatus,
  seedSyncRuns,
} from "./devSeedData";
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "./limits";
import { METRICS, getMetric, staleAfter } from "./metricRegistry";
import { cleanDomain, refusal } from "./mirrorRules";
import { isCanonicalPeriodStart, periodStart } from "./periods";
import { cleanDealDetails } from "./pipelineFields";
import { PIPELINE_OWNERS } from "./pipelineRules";
import { STAGES, UNMAPPED, normalizeStage } from "./pipelineStages";
import { PLAN_KEYS, PLAN_KEY_DEFS, PLAN_SCENARIOS, PLAN_VERSION_PATTERN } from "./planShape";
import { APOLLO_FINISHED_WEEK_KEYS, pushedSnapshotProblems } from "./pushRules";
import { sharedRefusal } from "./sharedRecords";
import { validateSnapshots } from "./snapshotRules";

// The made-up data set, checked against the rules real data is held to. A few
// instants, so a month's first day, a Monday and a year's end are all tried.
const NOWS = [
  Date.parse("2026-10-13T12:00:00Z"),
  Date.parse("2026-11-01T00:00:01Z"),
  Date.parse("2026-12-28T08:00:00Z"),
  Date.parse("2027-01-01T23:59:00Z"),
  Date.parse("2027-03-31T23:59:59Z"),
];
const NOW = NOWS[0]!;

describe("the seeded figures", () => {
  test.each(NOWS)("every batch passes the registry's own check at %d", (now) => {
    for (const { source, rows } of seedSnapshots(now)) {
      expect([source, validateSnapshots(source, rows, undefined, { now })]).toEqual([source, []]);
      // And what a push would be held to: no product week, and no week's own
      // count, for a week still in progress. (Apollo's totals to date are a
      // history here, which no single push could send.)
      const weekly = rows.filter(
        (row) => source !== "apollo" || APOLLO_FINISHED_WEEK_KEYS.includes(row.key),
      );
      expect([source, pushedSnapshotProblems(source, weekly, now)]).toEqual([source, []]);
    }
  });

  test("every metric in the registry has figures, for every one of its scopes", () => {
    const seeded = new Set(
      seedSnapshots(NOW).flatMap(({ rows }) => rows.map((row) => `${row.key}:${row.scope}`)),
    );
    for (const metric of METRICS) {
      // An event is seeded once, in its first scope.
      const scopes = metric.sparse ? Object.keys(metric.sources).slice(0, 1) : Object.keys(metric.sources);
      for (const scope of scopes) expect(seeded).toContain(`${metric.key}:${scope}`);
    }
  });

  test("no level is out of date on the day it is seeded", () => {
    for (const { rows } of seedSnapshots(NOW)) {
      const newest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const id = `${row.key}:${row.scope}`;
        if (!newest.has(id) || newest.get(id)!.periodStart < row.periodStart) newest.set(id, row);
      }
      for (const [id, row] of newest) {
        const metric = getMetric(row.key)!;
        if (metric.sparse) continue;
        expect([id, freshness(NOW, row.period, row.periodStart, staleAfter(metric, row.scope))]).toEqual([
          id,
          "fresh",
        ]);
      }
    }
  });

  test("a part is never more than its whole", () => {
    const rows = seedSnapshots(NOW).flatMap((batch) => batch.rows);
    const at = (key: string, scope: string, start: string) =>
      rows.find((r) => r.key === key && r.scope === scope && r.periodStart === start)!.value;
    for (const [part, whole] of [
      ["signups_activated", "signups"],
      ["deploys_failed", "deploys"],
      ["search_clicks", "search_impressions"],
      ["outbound_opened", "outbound_delivered"],
      ["outbound_replied", "outbound_delivered"],
      ["apollo_tasks_overdue", "apollo_tasks_open"],
    ] as const) {
      for (const row of rows.filter((r) => r.key === part)) {
        expect(row.value).toBeLessThanOrEqual(at(whole, row.scope, row.periodStart));
      }
    }
  });

  test("a total to date never falls", () => {
    const delivered = seedSnapshots(NOW)
      .flatMap((batch) => batch.rows)
      .filter((row) => row.key === "outbound_delivered")
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    expect(delivered.length).toBeGreaterThan(20);
    delivered.forEach((row, i) => {
      if (i > 0) expect(row.value).toBeGreaterThanOrEqual(delivered[i - 1]!.value);
    });
  });

  test("the same moment gives the same rows", () => {
    expect(seedSnapshots(NOW)).toEqual(seedSnapshots(NOW));
  });

  test("the months are the thirteen that have ended, oldest first", () => {
    const months = closedMonths(NOW, 13);
    expect(months[0]).toBe("2025-09-01");
    expect(months.at(-1)).toBe("2026-09-01");
    expect(months.every((month) => isCanonicalPeriodStart("month", month))).toBe(true);
  });

  test("a target is set only for a metric and scope that exist", () => {
    for (const target of SEED_TARGETS) {
      expect(getMetric(target.key)?.sources).toHaveProperty(target.scope);
    }
  });
});

describe("the seeded sources", () => {
  test("every source in the manifest has a state, and both a failure and an unset source show", () => {
    const rows = seedSourceStatus(NOW);
    expect(rows.map((row) => row.source).sort()).toEqual(SOURCES.map((s) => s.id).sort());
    expect(new Set(rows.map((row) => row.state))).toEqual(new Set(["ok", "error", "not_configured"]));
    for (const row of rows) expect(row.lastRunAt).toBeLessThanOrEqual(NOW);
  });

  test("the run log names only sources that exist, and holds counts", () => {
    const ids = SOURCES.map((s) => s.id as string);
    for (const run of seedSyncRuns(NOW)) {
      expect(ids).toContain(run.source);
      expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    }
  });
});

describe("the seeded pipelines", () => {
  test("deals are on both boards, in stages the OS knows, each source where it may write", () => {
    const deals = seedDeals(NOW);
    expect(new Set(deals.map((deal) => deal.market))).toEqual(new Set(["us", "kz"]));
    for (const deal of deals) {
      expect([...STAGES.deals, UNMAPPED]).toContain(deal.stage);
      expect(deal.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      if (deal.native) {
        expect([deal.source, deal.market]).toEqual(["manual", "us"]);
      } else {
        // A mirrored row: its source owns that market's board, and the stage
        // is what the OS makes of the source's own name for it.
        expect(PIPELINE_OWNERS.deals[deal.source as "kz_crm"].market).toBe(deal.market);
        expect(normalizeStage("deals", deal.sourceStage!)).toBe(deal.stage);
        expect(deal.externalId).not.toBe("");
      }
    }
    // Every column of each board has a card, the Unsorted one included.
    for (const market of ["us", "kz"] as const) {
      const stages = new Set(deals.filter((d) => d.market === market).map((d) => d.stage));
      for (const stage of STAGES.deals) expect([market, [...stages]]).toEqual([market, expect.arrayContaining([stage])]);
    }
    expect(deals.some((deal) => deal.stage === UNMAPPED)).toBe(true);
  });

  test("some US deals carry details the board would accept; Kazakhstan's none; one US deal is archived", () => {
    const deals = seedDeals(NOW);
    const detailed = deals.filter((deal) => deal.priority !== undefined);
    expect(detailed.length).toBeGreaterThan(2);
    for (const deal of detailed) {
      expect(deal.market).toBe("us");
      const { priority, region, physicians, locations, sources } = deal;
      expect(cleanDealDetails({ priority, region, physicians, locations, sources })).toEqual(
        Object.fromEntries(
          Object.entries({ priority, region, physicians, locations, sources }).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      );
    }
    for (const deal of deals.filter((d) => d.market === "kz")) {
      expect(["priority", "region", "physicians", "locations", "sources"].some((key) => key in deal)).toBe(false);
    }
    const archived = deals.filter((deal) => deal.archivedAt !== undefined);
    expect(archived.map((deal) => [deal.market, deal.native])).toEqual([["us", true]]);
  });

  test("some US deals on the board carry intelligence the server would accept, as stored, and read as made up", () => {
    const deals = seedDeals(NOW);
    expect(SEED_DEAL_INTEL.length).toBeGreaterThanOrEqual(3);
    for (const { deal: name, intel } of SEED_DEAL_INTEL) {
      const deal = deals.find((d) => d.name === name);
      expect([name, deal?.market, deal?.native, deal?.archivedAt]).toEqual([name, "us", true, undefined]);
      const cleaned = cleanIntelEdit(intel);
      expect(cleaned).toEqual({ ok: true, patch: intel });
      for (const source of intel.sources ?? []) expect(source.url).toMatch(/^https:\/\/claude\.ai\/artifact\/made-up-/);
      for (const person of intel.people ?? []) expect(person.name).toMatch(/Example|Sample|Placeholder|Mock/);
    }
    // And one researched deal with nothing but a summary, so the page's empty sections are seen.
    expect(SEED_DEAL_INTEL.some(({ intel }) => Object.keys(intel).length <= 2)).toBe(true);
  });

  test("order runs 0, 1, 2 within each column", () => {
    const columns = new Map<string, number[]>();
    for (const deal of seedDeals(NOW)) {
      const key = `${deal.market}:${deal.stage}`;
      columns.set(key, [...(columns.get(key) ?? []), deal.order]);
    }
    for (const orders of columns.values()) expect(orders).toEqual(orders.map((_, i) => i));
  });

  test("investors fill every stage, and a closed card has its close date", () => {
    const investors = seedInvestors(NOW);
    for (const stage of STAGES.investors) {
      expect(investors.map((row) => row.stage)).toContain(stage);
    }
    for (const row of [...investors, ...seedDeals(NOW)]) {
      const closed = ["won", "lost", "committed", "passed"].includes(row.stage);
      expect(row.closedAt !== undefined).toBe(closed);
      expect(row.lastActivityAt).toBeLessThanOrEqual(NOW);
    }
  });
});

describe("the seeded customers and obligations", () => {
  test("clinics in both markets, in their market's currency, with every status and an archived one", () => {
    const clinics = seedCustomers(NOW);
    expect(new Set(clinics.map((c) => c.status))).toEqual(new Set(["active", "paused", "churned"]));
    expect(clinics.some((c) => c.archivedAt !== undefined)).toBe(true);
    expect(new Set(clinics.map((c) => c.nameKey)).size).toBe(clinics.length);
    for (const clinic of clinics) {
      expect(clinic.currency).toBe(clinic.market === "us" ? "USD" : "KZT");
      expect(clinic.source).toBe("client_register");
      for (const date of [clinic.lastPaymentDate, clinic.lastUsageDate, clinic.contractDate, clinic.baaDate, clinic.nextTouch]) {
        if (date !== undefined) expect(isCanonicalPeriodStart("day", date)).toBe(true);
      }
      // Nothing known is later than the push that carried it.
      for (const date of [clinic.lastPaymentDate, clinic.lastUsageDate]) {
        if (date !== undefined) expect(date <= periodStart("day", clinic.syncedAt)).toBe(true);
      }
    }
  });

  test("every clinic reads as invented, by an English placeholder word, and every won deal is a clinic on the register", () => {
    const clinics = seedCustomers(NOW);
    for (const clinic of clinics) expect(clinic.name).toMatch(/^[A-Za-z0-9 .()-]+$/);
    for (const clinic of clinics) expect(clinic.name).toMatch(/Example|Sample|Placeholder|Mock|Demo|Test|Fictional|Maple|Harbor|Mockingbird/);
    const names = new Set(clinics.map((c) => c.name));
    for (const deal of seedDeals(NOW).filter((d) => d.market === "kz" && d.stage === "won")) expect(names, deal.name).toContain(deal.name);
  });

  test("the app's made-up clinics have round numbers of doctors", () => {
    const clinics = seedCustomers(NOW)
      .filter((c) => c.market === "kz" && c.status === "active" && c.archivedAt === undefined)
      .map((c) => ({ id: c.name, name: c.name }));
    const usage = seedCustomerUsage(NOW, clinics);
    expect(new Set(usage.map((u) => u.customerId)).size).toBeGreaterThanOrEqual(10);
    for (const u of usage) {
      expect([1, 2, 5, 10, 20], u.customerId).toContain(u.doctorsTotal);
    }
  });

  test("a spread of health: something on record and nothing on record, for each signal", () => {
    const active = seedCustomers(NOW).filter((c) => c.status === "active" && c.archivedAt === undefined);
    for (const field of ["lastPaymentDate", "amountOwed", "lastUsageDate"] as const) {
      expect(active.some((c) => c[field] !== undefined)).toBe(true);
      expect(active.some((c) => c[field] === undefined)).toBe(true);
    }
    expect(active.some((c) => (c.amountOwed ?? 0) > 2 * (c.monthlyFee ?? Infinity))).toBe(true);
  });

  test("obligations: every category, dates that are dates, and evidence only as https links", () => {
    const rows = seedObligations(NOW);
    expect(new Set(rows.map((row) => row.category)).size).toBe(5);
    expect(rows.some((row) => row.due !== undefined && !row.dueConfirmed)).toBe(true);
    for (const row of rows) {
      if (row.due !== undefined) {
        expect(isCanonicalPeriodStart("day", row.due)).toBe(true);
        expect(row.anchorDay).toBe(Number(row.due.slice(8)));
      }
      // No invented deadline: a date is confirmed only where one is given.
      if (row.dueConfirmed) expect(row.due).toBeDefined();
      for (const link of [row.evidenceUrl, row.lastEvidenceUrl]) {
        if (link !== undefined) expect(link.startsWith("https://example.com/")).toBe(true);
      }
      // The page never says the company meets anything, and nor does the seed.
      expect(row.title).not.toMatch(/compliant|certified|covered/i);
    }
  });
});

describe("the seeded routine", () => {
  test("goals are this quarter's, in every state", () => {
    const goals = seedGoals(NOW);
    expect(new Set(goals.map((goal) => goal.quarter))).toEqual(new Set(["2026-Q4"]));
    expect(new Set(goals.map((goal) => goal.status)).size).toBe(4);
  });

  test("tasks fill every column: some given to a seeded person, two from the standup, one suggested", () => {
    for (const column of ["backlog", "this_week", "doing", "done"]) {
      expect(SEED_TASKS.some((task) => task.column === column)).toBe(true);
    }
    expect(SEED_TASKS.filter((task) => task.from === "standup")).toHaveLength(2);
    const suggested = SEED_TASKS.filter((task) => task.from === "suggestion");
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toMatchObject({ column: "backlog", by: { role: "sales" } });
    expect(suggested[0]).not.toHaveProperty("company");
    const people = SEED_PEOPLE.map(emailOf);
    for (const task of SEED_TASKS) {
      expect(task.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
      expect((task.notes ?? "").length).toBeLessThanOrEqual(MAX_NOTES_LENGTH);
      for (const who of [task.assignee, task.by]) if (who) expect(people).toContain(emailOf(who));
      expect(task.done !== undefined).toBe(task.column === "done");
      // Whoever holds a task of one company is on that company.
      if (task.assignee && task.company && task.assignee.companies !== "both") {
        expect(task.assignee.companies).toBe(task.company);
      }
      if (task.goal !== undefined) expect(seedGoals(NOW)[task.goal]).toBeDefined();
    }
  });

  test("the bell has something for the owner and for a teammate of every role, of every kind", () => {
    const people = SEED_PEOPLE.map(emailOf);
    const kinds = new Set(SEED_NOTIFICATIONS.map((told) => told.kind));
    expect([...kinds].sort()).toEqual(
      ["assigned", "due", "finished", "mentioned", "moved", "reassigned", "unassigned"].sort(),
    );
    for (const role of ["owner", "cofounder", "sales", "engineer"]) {
      const theirs = SEED_NOTIFICATIONS.filter((told) => told.to.role === role);
      expect([role, theirs.some((told) => !told.read)]).toEqual([role, true]);
    }
    expect(SEED_NOTIFICATIONS.some((told) => told.read)).toBe(true);
    expect(SEED_NOTIFICATIONS.some((told) => told.by === "standup")).toBe(true);
    for (const told of SEED_NOTIFICATIONS) {
      const task = SEED_TASKS.find((one) => one.title === told.task);
      expect([told.task, task !== undefined]).toEqual([told.task, true]);
      expect(people).toContain(emailOf(told.to));
      if (told.by !== "standup") {
        expect(people).toContain(emailOf(told.by));
        // Nobody is told of what they did themselves.
        expect(emailOf(told.by)).not.toBe(emailOf(told.to));
      }
      // Whoever is told of a company's task is on that company.
      if (task!.company && told.to.companies !== "both") {
        expect(told.to.companies).toBe(task!.company);
      }
      expect(told.kind === "moved").toBe(told.column !== undefined);
      expect(told.kind === "reassigned").toBe(told.now !== undefined);
      expect(told.kind === "due").toBe(told.due !== undefined);
      expect(told.hoursAgo).toBeGreaterThan(0);
    }
  });

  test("a task that mentions someone says so in its notes, by the name they go by", () => {
    const mentioning = SEED_TASKS.filter((task) => task.mentions !== undefined);
    expect(mentioning.length).toBeGreaterThan(0);
    for (const task of mentioning) {
      for (const person of task.mentions!) {
        const name = SEED_PEOPLE.find((p) => emailOf(p) === emailOf(person))!.name;
        expect(task.notes).toContain(`@${name}`);
      }
    }
  });

  test("the plan is whole: every scenario, year and figure, within the plan's own limits", () => {
    const rows = seedPlan(NOW);
    expect(rows).toHaveLength(PLAN_SCENARIOS.length * 5 * PLAN_KEYS.length);
    for (const row of rows) {
      const def = PLAN_KEY_DEFS[row.key as (typeof PLAN_KEYS)[number]];
      expect(row.value).toBeGreaterThanOrEqual(def.min);
      expect(row.value).toBeLessThanOrEqual(def.max);
      expect(Number.isInteger(row.value)).toBe(true);
      expect(row.modelVersion).toMatch(PLAN_VERSION_PATTERN);
    }
  });
});

describe("the seeded unit economics", () => {
  const windowOf = (now: number) => {
    const month = periodStart("month", now).slice(0, 7);
    return [-3, -2, -1].map((by) => addMonths(month, by));
  };

  test("each company has lines serving customers and selling, and some chosen by hand", () => {
    for (const company of ["us", "kz"] as const) {
      const mine = SEED_COSTS.filter((line) => line.company === company);
      expect(mine.some((line) => bucketOf(line) === "cogs"), company).toBe(true);
      expect(mine.some((line) => bucketOf(line) === "sales_marketing"), company).toBe(true);
      expect(mine.some((line) => line.bucket !== undefined), company).toBe(true);
    }
  });

  test("Globex paid an agency in one-offs in each of the last three months, one of them large", () => {
    const agency = SEED_COSTS.filter(
      (line) => line.company === "kz" && line.category === "marketing" && line.cadence === "once",
    );
    expect(agency.map((line) => line.startsIn).sort()).toEqual([-1, -2, -3]);
    expect(Math.max(...agency.map((line) => line.amount))).toBeGreaterThan(5 * Math.min(...agency.map((line) => line.amount)));
  });

  test("people's time shares are whole, 100% at most, and each company has some of each", () => {
    for (const person of SEED_PAY_PEOPLE) {
      expect(timeSharesProblem(person.cogsPercent ?? 0, person.salesPercent ?? 0), person.name).toBeNull();
    }
    for (const company of ["us", "kz"] as const) {
      const mine = SEED_PAY_PEOPLE.filter((person) => person.company === company);
      expect(mine.some((person) => (person.cogsPercent ?? 0) > 0), company).toBe(true);
      expect(mine.some((person) => (person.salesPercent ?? 0) > 0), company).toBe(true);
    }
  });

  test.each(NOWS)("clinics of each company were contracted in the three complete months before %s, and one has no date", (now) => {
    const window = windowOf(now);
    const clinics = seedCustomers(now).filter((clinic) => clinic.archivedAt === undefined);
    for (const company of ["us", "kz"] as const) {
      const recent = clinics.filter(
        (clinic) => clinic.market === company && clinic.contractDate !== undefined && window.includes(clinic.contractDate.slice(0, 7)),
      );
      expect(recent.length, company).toBeGreaterThan(0);
    }
    expect(clinics.some((clinic) => clinic.contractDate === undefined)).toBe(true);
  });
});

describe("the seeded team and payroll", () => {
  test("the owner and two teammates of each role, each address once, all on the reserved domain", () => {
    const emails = SEED_PEOPLE.map(emailOf);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails[0]).toBe(LOCAL_OWNER_EMAIL);
    for (const role of LOCAL_ROLES.filter((r) => r !== "owner")) {
      expect(SEED_PEOPLE.filter((p) => p.role === role)).toHaveLength(2);
      // The default of `pnpm dev:signin <role>` is someone the seed made.
      expect(SEED_PEOPLE.some((p) => p.role === role && p.companies === "both")).toBe(true);
    }
    for (const email of emails) expect(email.endsWith(`@${LOCAL_DOMAIN}`)).toBe(true);
    // One person of every role that is on both companies has the Today page,
    // so the page can be looked at for each focus. The first has records.
    expect(SEED_PEOPLE.filter((p) => p.today).map((p) => [p.role, p.companies])).toEqual([
      ["cofounder", "both"],
      ["sales", "both"],
      ["engineer", "both"],
      ["marketing", "both"],
      ["success", "both"],
    ]);
    expect(TODAY_TEAMMATE.name).toBe("Ada Example");
  });

  test("two of the local roles are roles the owner named, with different focuses and ordinary pages", () => {
    expect(Object.keys(SEED_ROLES)).toEqual(["marketing", "success"]);
    expect(SEED_ROLES.marketing).toMatchObject({ name: "Marketing", focus: "marketing" });
    expect(SEED_ROLES.success).toMatchObject({ name: "Customer success", focus: "customers" });
    for (const role of Object.values(SEED_ROLES)) expect(cleanPreset(role.areas)).toEqual(role.areas);
    expect(seedAreasOf("success")).toEqual(["customers", "board"]);
    expect(seedAreasOf("engineer")).toEqual(["product", "engineering", "board", "agents"]);
    expect(seedAreasOf("owner")).toEqual([]);
  });

  test("a local person nobody seeded still has a name that says what they are", () => {
    expect(localName("sales", "both")).toBe("Sam Placeholder");
    expect(localName("sales", "kz")).toBe("Sales Example (kz)");
  });

  test("costs: a dozen made-up lines a company, every cadence, two estimates, one ended, a one-off next month", () => {
    for (const company of ["us", "kz"] as const) {
      const lines = SEED_COSTS.filter((line) => line.company === company);
      // Globex's agency, paid a one-off a month for the last three, is three more.
      expect(lines).toHaveLength(company === "us" ? 12 : 15);
      for (const cadence of ["monthly", "quarterly", "yearly", "once"]) {
        expect([cadence, lines.some((line) => line.cadence === cadence)]).toEqual([cadence, true]);
      }
      expect(lines.filter((line) => line.cadence === "once" && line.startsIn === 1)).toHaveLength(1);
      expect(lines.filter((line) => line.variable === true)).toHaveLength(2);
      expect(lines.filter((line) => line.endsIn !== undefined && line.endsIn < 0)).toHaveLength(1);
      expect(new Set(lines.map((line) => line.category)).size).toBeGreaterThanOrEqual(6);
    }
    for (const line of SEED_COSTS) {
      expect(line.name).toMatch(/Example|Sample|Placeholder|Made-up/);
      expect(Number.isInteger(line.amount) && line.amount > 0).toBe(true);
      for (const text of [line.name, line.paidBy ?? "", line.note ?? ""]) {
        expect(looksLikeAccountNumber(text)).toBe(false);
      }
    }
    // Months are counted from the month in progress, so the page is never stale.
    expect(seedCostMonth(Date.UTC(2026, 9, 13), 0)).toBe("2026-10");
    expect(seedCostMonth(Date.UTC(2026, 9, 13), 3)).toBe("2027-01");
    expect(seedCostMonth(Date.UTC(2026, 9, 13), -10)).toBe("2025-12");
  });

  test("payroll: both companies, whole minor units, a net-based person, and lines that say they are made up", () => {
    for (const company of ["us", "kz"] as const) {
      const people = SEED_PAY_PEOPLE.filter((p) => p.company === company);
      expect(people.some((p) => p.kind === "contractor")).toBe(true);
      expect(people.some((p) => p.net !== undefined)).toBe(true);
      expect(SEED_PAY_LINES.some((line) => line.company === company)).toBe(true);
    }
    for (const person of SEED_PAY_PEOPLE) {
      // One figure, the one that was "entered", and never both.
      expect((person.gross === undefined) !== (person.net === undefined)).toBe(true);
      expect(Number.isInteger(person.gross ?? person.net)).toBe(true);
    }
    const keys = SEED_PAY_LINES.map((line) => line.key);
    for (const line of SEED_PAY_LINES) {
      expect(line.name).toMatch(/^Made-up /);
      expect(Number.isInteger(line.rateBp)).toBe(true);
      // A line subtracts only lines of its own company that come before it.
      for (const less of line.less ?? []) {
        expect(keys.indexOf(less)).toBeLessThan(keys.indexOf(line.key));
        expect(less.slice(0, 2)).toBe(line.company);
      }
    }
  });
});

describe("the seeded work tools", () => {
  test.each(["owner", "teammate"] as const)("the %s's records pass the mirror's own rules", (holder) => {
    const batches = seedMirror(NOW, holder);
    expect(batches.map((batch) => batch.source).sort()).toEqual([
      "fireflies",
      "gmail",
      "google_calendar",
      "linear",
    ]);
    for (const { source, rows } of batches) {
      expect(rows.length).toBeGreaterThan(0);
      expect([source, refusal(source, rows)]).toEqual([source, null]);
    }
  });

  test("the two holders share no record id", () => {
    const ids = (holder: "owner" | "teammate") =>
      seedMirror(NOW, holder).flatMap(({ rows }) => rows.map((row) => JSON.stringify(row).match(/seed-[a-z]+-[ot]\d+/)![0]));
    expect(ids("owner").filter((id) => ids("teammate").includes(id))).toEqual([]);
  });

  test("today's calendar has meetings today, and the shared board has issues of both companies", () => {
    const of = (source: string) => seedMirror(NOW, "owner").find((b) => b.source === source)!.rows;
    const today = periodStart("day", NOW);
    expect(
      of("google_calendar").filter((r) => r.kind === "event" && periodStart("day", r.startsAt) === today).length,
    ).toBeGreaterThanOrEqual(2);
    const teams = new Set(of("linear").map((r) => (r.kind === "issue" ? r.teamName : "")));
    expect([...teams].some((team) => /^Startup/.test(team))).toBe(true);
    expect([...teams].some((team) => /^Globex/.test(team))).toBe(true);
  });

  test("Apollo's lists pass their own rules, and the domain lists are domains", () => {
    const shared = seedShared(NOW);
    for (const kind of ["sequence", "stage_count"] as const) {
      expect(sharedRefusal(kind, shared.filter((record) => record.kind === kind))).toBeNull();
    }
    for (const domain of [
      ...SEED_WORK_TOOL_SETTINGS.investorDomains,
      ...SEED_WORK_TOOL_SETTINGS.customerDomains,
    ]) {
      expect(cleanDomain(domain)).toBe(domain);
    }
  });
});

describe("nothing in the seed could be taken for real", () => {
  const everything = (now: number) =>
    JSON.stringify([
      SEED_PEOPLE,
      seedDeals(now),
      seedInvestors(now),
      seedCustomers(now),
      seedObligations(now),
      seedGoals(now),
      SEED_TASKS,
      SEED_NOTIFICATIONS,
      SEED_PAY_PEOPLE,
      SEED_PAY_LINES,
      seedMirror(now, "owner"),
      seedMirror(now, "teammate"),
      seedShared(now),
      SEED_WORK_TOOL_SETTINGS,
    ]);

  test("every address is on a reserved .test domain, and every link is example.com or Linear's example workspace", () => {
    const text = everything(NOW);
    for (const address of text.match(/[a-z0-9._-]+@[a-z0-9.-]+/gi) ?? []) {
      expect(address).toMatch(/\.test$/);
    }
    for (const link of text.match(/https?:\/\/[^"\\ ]+/g) ?? []) {
      expect(link).toMatch(/^https:\/\/(example\.com|linear\.app\/example)\//);
    }
  });

  test("no real company's own domain appears", () => {
    expect(everything(NOW)).not.toMatch(/startup\.ai|globex\.ai|gmail\.com|convex\.cloud/i);
  });
});
