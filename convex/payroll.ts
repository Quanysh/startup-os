import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import { MARKET_CURRENCY, requireOfferedCurrency, startingCurrencyOf } from "./lib/customerShape";
import {
  MAX_LINE_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PAYROLL_AMOUNT,
  MAX_PAYROLL_LINES,
  MAX_PAYROLL_NOTE_LENGTH,
  MAX_PAYROLL_PEOPLE,
  MAX_RUNS_LISTED,
  MAX_RUN_CELLS,
} from "./lib/limits";
import { cleanRemote } from "./lib/mirrorRules";
import { memberMutation, memberQuery, requireCompany } from "./lib/owner";
import {
  BP,
  CYCLE_MESSAGE,
  PayrollCycleError,
  activeIn,
  draftRows,
  findCycle,
  linesFor,
  readRow,
  rowSums,
  timeSharesProblem,
  totalsOf,
  type PayPerson,
  type PayRow,
  type PayrollKind,
  type PayrollLineRow,
} from "./lib/payroll";
import { isCanonicalPeriodStart } from "./lib/periods";
import {
  companyValidator,
  payBasisValidator,
  payerValidator,
  payrollCurrencyValidator,
  payrollKindValidator,
} from "./schema";

// Payroll: the people each company pays, the tax and contribution lines set
// for it, and the months saved from them. Every function here is gated by the
// `payroll` area: the owner's, and a teammate's only when the owner ticked it
// for them by name (it is in no role's starting set).
//
// Every function is also one company's. One that takes a `company` refuses a
// caller who is not on it; one that takes an id reads the row and refuses a
// caller who is not on the row's company, before anything else is read or
// changed. Both in the gate's own words (`requireCompany`), so a holder on
// one company learns nothing of the other's people, lines or months.
//
// A salary is sensitive personal data. Nothing in this file writes a name or
// an amount anywhere but the three payroll tables, logs one, or puts one in
// a thrown message: every refusal is in fixed words.
//
// No rate, threshold or rule of any tax law is written here. A rate is what
// the owner typed; `addUsualLines` offers names and nothing else.

type Row = PayRow<Id<"payrollPeople">>;

const payrollQuery = memberQuery("payroll");
const payrollMutation = memberMutation("payroll");

// ── Cleaning what was typed ─────────────────────────────────────────────────

/**
 * One line of typed text: control, direction-override and invisible
 * characters removed by the rule mirrored text is held to (`cleanRemote`),
 * then refused, not cut, when it is too long. Blank comes back as "".
 */
function cleanLine(text: string, max: number, tooLong: string): string {
  // Nobody types this much; do not run the cleaner over a runaway paste.
  if (text.length > max * 8) throw new ConvexError(tooLong);
  const flat = cleanRemote(text, Number.POSITIVE_INFINITY);
  if (flat.length > max) throw new ConvexError(tooLong);
  return flat;
}

const tooLong = (what: string, max: number) => `That ${what} is too long (${max} characters at most).`;

function cleanName(name: string, what: "person" | "line"): string {
  const max = what === "person" ? MAX_NAME_LENGTH : MAX_LINE_NAME_LENGTH;
  const clean = cleanLine(name, max, tooLong("name", max));
  if (clean === "") throw new ConvexError(`A ${what} needs a name.`);
  return clean;
}

const cleanOptional = (text: string, max: number, what: string) =>
  cleanLine(text, max, tooLong(what, max)) || undefined;

/** A whole number of minor units, zero or more, within the limit. */
function cleanAmount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError(`The ${what} must be a whole amount, zero or more.`);
  }
  if (value > MAX_PAYROLL_AMOUNT) throw new ConvexError(`The ${what} is too large.`);
  return value;
}

function cleanRate(rateBp: number): number {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > BP) {
    throw new ConvexError("A rate is from 0% to 100%, with two decimals at most.");
  }
  return rateBp;
}

function checkDay(value: string | null | undefined, what: string) {
  if (value != null && !isCanonicalPeriodStart("day", value)) {
    throw new ConvexError(`The ${what} is not a date.`);
  }
}

function checkDates(start: string | undefined, end: string | undefined) {
  if (start !== undefined && end !== undefined && end < start) {
    throw new ConvexError("The end date is before the start date.");
  }
}

function checkMonth(month: string): string {
  if (!isCanonicalPeriodStart("month", month)) throw new ConvexError("That is not a month.");
  return month;
}

/** `undefined` keeps what is stored, `null` clears it, anything else replaces it. */
function replaced<Value, Stored>(
  given: Value | null | undefined,
  stored: Stored | undefined,
  clean: (value: Value) => Stored | undefined,
): Stored | undefined {
  return given === undefined ? stored : given === null ? undefined : clean(given);
}

// ── Reading the three tables ────────────────────────────────────────────────

const peopleOf = (ctx: QueryCtx, company: CompanyId) =>
  ctx.db
    .query("payrollPeople")
    .withIndex("by_company", (q) => q.eq("company", company))
    .collect();

const linesOf = (ctx: QueryCtx, company: CompanyId) =>
  ctx.db
    .query("payrollLines")
    .withIndex("by_company", (q) => q.eq("company", company))
    .collect();

const runOf = (ctx: QueryCtx, company: CompanyId, month: string) =>
  ctx.db
    .query("payrollRuns")
    .withIndex("by_company_and_month", (q) => q.eq("company", company).eq("month", month))
    .unique();

const KIND_ORDER: Record<PayrollKind, number> = { employee: 0, contractor: 1 };

type LineRow = Omit<PayrollLineRow, "id" | "lessLineIds"> & {
  id: Id<"payrollLines">;
  lessLineIds: Id<"payrollLines">[];
};

function presentLine(line: Doc<"payrollLines">): LineRow {
  return {
    id: line._id,
    name: line.name,
    appliesTo: line.appliesTo,
    paidBy: line.paidBy,
    rateBp: line.rateBp ?? null,
    lessLineIds: line.lessLineIds,
    allowance: line.allowance,
    baseCap: line.baseCap ?? null,
    order: line.order,
    active: line.active,
  };
}

/**
 * When a person or a line was made or last changed: the page header's "last
 * change" (with each saved month's `preparedAt`). A row from before
 * `updatedAt` was kept has only its making to go by.
 */
const changedAt = (row: Doc<"payrollPeople"> | Doc<"payrollLines">) =>
  row.updatedAt ?? row._creationTime;

function presentPerson(person: Doc<"payrollPeople">) {
  return {
    id: person._id,
    name: person.name,
    title: person.title ?? null,
    kind: person.kind,
    payBasis: person.payBasis ?? "gross",
    monthlyGross: person.monthlyGross ?? null,
    monthlyNet: person.monthlyNet ?? null,
    currency: person.currency,
    startDate: person.startDate ?? null,
    endDate: person.endDate ?? null,
    notes: person.notes ?? null,
    cogsPercent: person.cogsPercent ?? 0,
    salesPercent: person.salesPercent ?? 0,
    order: person.order,
    archivedAt: person.archivedAt ?? null,
  } satisfies PayPerson<Id<"payrollPeople">> & Record<string, unknown>;
}

/**
 * A person's two shares of time as they are stored: refused in fixed words
 * when not whole percents or over 100% together (`timeSharesProblem`), a
 * share of 0 stored as nothing. `kept` is what is stored now, for an edit
 * that leaves one out.
 */
function cleanShares(
  given: { cogsPercent?: number; salesPercent?: number },
  kept: { cogsPercent?: number; salesPercent?: number } = {},
): { cogsPercent: number | undefined; salesPercent: number | undefined } {
  const cogs = given.cogsPercent ?? kept.cogsPercent ?? 0;
  const sales = given.salesPercent ?? kept.salesPercent ?? 0;
  const problem = timeSharesProblem(cogs, sales);
  if (problem !== null) throw new ConvexError(problem);
  return { cogsPercent: cogs === 0 ? undefined : cogs, salesPercent: sales === 0 ? undefined : sales };
}

const NET_ONLY = "Someone entered as net needs a monthly net, and no monthly gross.";
const GROSS_ONLY = "Someone entered as gross needs a monthly gross, and no monthly net.";

/**
 * The one figure that goes with a pay basis, cleaned; the other is refused
 * rather than dropped, so a caller cannot believe it stored both. `kept` is
 * the figure already stored for that basis, used when none is given.
 */
function cleanPay(
  basis: "net" | "gross",
  given: { monthlyGross?: number; monthlyNet?: number },
  kept?: number,
): { monthlyGross?: number; monthlyNet?: number } {
  const [mine, other, refusal, what] =
    basis === "net"
      ? ([given.monthlyNet, given.monthlyGross, NET_ONLY, "monthly net"] as const)
      : ([given.monthlyGross, given.monthlyNet, GROSS_ONLY, "monthly gross"] as const);
  if (other !== undefined) throw new ConvexError(refusal);
  const figure = mine === undefined ? kept : cleanAmount(mine, what);
  if (figure === undefined) throw new ConvexError(refusal);
  return basis === "net"
    ? { monthlyNet: figure, monthlyGross: undefined }
    : { monthlyGross: figure, monthlyNet: undefined };
}

// ── People ──────────────────────────────────────────────────────────────────

/**
 * Everyone a company pays, ended and archived included, in order. `removable`
 * is false for someone a saved month holds: they can be ended or archived,
 * never deleted.
 */
export const listPeople = payrollQuery({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const held = new Set<string>();
    const runs = ctx.db
      .query("payrollRuns")
      .withIndex("by_company_and_month", (q) => q.eq("company", args.company));
    for await (const run of runs) for (const row of run.rows) held.add(row.personId);
    return (await peopleOf(ctx, args.company))
      .sort((a, b) => a.order - b.order)
      .map((person) => ({
        ...presentPerson(person),
        removable: !held.has(person._id),
        changedAt: changedAt(person),
      }));
  },
});

export const createPerson = payrollMutation({
  args: {
    company: companyValidator,
    name: v.string(),
    title: v.optional(v.string()),
    kind: payrollKindValidator,
    /** How the pay is entered. Gross when left out. */
    payBasis: v.optional(payBasisValidator),
    /**
     * The figure that goes with the basis, and only that one, in the
     * currency's minor unit (cents, tiyn): the gross, or for someone entered
     * as net what they receive after everything withheld.
     */
    monthlyGross: v.optional(v.number()),
    monthlyNet: v.optional(v.number()),
    /** The company's own when left out. */
    currency: v.optional(payrollCurrencyValidator),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    notes: v.optional(v.string()),
    /** Whole percents of their time serving customers and on sales and marketing; 0 when left out. */
    cogsPercent: v.optional(v.number()),
    salesPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    requireOfferedCurrency(args.currency);
    const name = cleanName(args.name, "person");
    const title = cleanOptional(args.title ?? "", MAX_NAME_LENGTH, "title");
    const pay = cleanPay(args.payBasis ?? "gross", args);
    const shares = cleanShares(args);
    checkDay(args.startDate, "start date");
    checkDay(args.endDate, "end date");
    checkDates(args.startDate, args.endDate);
    const notes = cleanOptional(args.notes ?? "", MAX_PAYROLL_NOTE_LENGTH, "note");

    const everyone = await peopleOf(ctx, args.company);
    if (everyone.length >= MAX_PAYROLL_PEOPLE) {
      throw new ConvexError(`The payroll is full (${MAX_PAYROLL_PEOPLE} people at most).`);
    }
    return await ctx.db.insert("payrollPeople", {
      company: args.company,
      name,
      title,
      kind: args.kind,
      ...(args.payBasis !== undefined ? { payBasis: args.payBasis } : null),
      ...pay,
      currency: args.currency ?? startingCurrencyOf(args.company),
      startDate: args.startDate,
      endDate: args.endDate,
      notes,
      ...shares,
      order: everyone.reduce((last, person) => Math.max(last, person.order + 1), 0),
    });
  },
});

/**
 * Edit a person. For the title, the dates and the note, null clears the
 * field and leaving it out keeps it. The pay basis changes only together
 * with its own figure, and the other figure is then dropped. A saved month is
 * a copy and never changes with the person.
 */
export const updatePerson = payrollMutation({
  args: {
    id: v.id("payrollPeople"),
    name: v.optional(v.string()),
    title: v.optional(v.union(v.string(), v.null())),
    kind: v.optional(payrollKindValidator),
    payBasis: v.optional(payBasisValidator),
    monthlyGross: v.optional(v.number()),
    monthlyNet: v.optional(v.number()),
    currency: v.optional(payrollCurrencyValidator),
    startDate: v.optional(v.union(v.string(), v.null())),
    endDate: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    /** Left out keeps the share; 0 clears it. */
    cogsPercent: v.optional(v.number()),
    salesPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) throw new ConvexError("That person no longer exists.");
    requireCompany(ctx.member, current.company);
    requireOfferedCurrency(args.currency);
    const shares = cleanShares(args, current);
    checkDay(args.startDate, "start date");
    checkDay(args.endDate, "end date");
    const startDate = replaced(args.startDate, current.startDate, (day) => day);
    const endDate = replaced(args.endDate, current.endDate, (day) => day);
    checkDates(startDate, endDate);
    const was = current.payBasis ?? "gross";
    const basis = args.payBasis ?? was;
    const pay = cleanPay(
      basis,
      args,
      basis !== was ? undefined : basis === "net" ? current.monthlyNet : current.monthlyGross,
    );

    await ctx.db.patch(args.id, {
      ...(args.name !== undefined ? { name: cleanName(args.name, "person") } : null),
      title: replaced(args.title, current.title, (title) =>
        cleanOptional(title, MAX_NAME_LENGTH, "title"),
      ),
      ...(args.kind !== undefined ? { kind: args.kind } : null),
      // Someone from before there was a choice keeps no basis of their own
      // until one is said.
      ...(args.payBasis !== undefined ? { payBasis: args.payBasis } : null),
      ...pay,
      ...(args.currency !== undefined ? { currency: args.currency } : null),
      startDate,
      endDate,
      notes: replaced(args.notes, current.notes, (notes) =>
        cleanOptional(notes, MAX_PAYROLL_NOTE_LENGTH, "note"),
      ),
      ...shares,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Put someone out of sight, and out of every month prepared from now on; or bring them back. */
export const archivePerson = payrollMutation({
  args: { id: v.id("payrollPeople"), archived: v.boolean() },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) throw new ConvexError("That person no longer exists.");
    requireCompany(ctx.member, current.company);
    if (args.archived === (current.archivedAt !== undefined)) return null;
    const now = Date.now();
    await ctx.db.patch(args.id, { archivedAt: args.archived ? now : undefined, updatedAt: now });
    return null;
  },
});

/**
 * Delete a person, which is allowed only while no saved month holds them: a
 * month's row points at its person. Removing someone already gone does nothing.
 */
export const removePerson = payrollMutation({
  args: { id: v.id("payrollPeople") },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) return null;
    requireCompany(ctx.member, current.company);
    const runs = ctx.db
      .query("payrollRuns")
      .withIndex("by_company_and_month", (q) => q.eq("company", current.company));
    for await (const run of runs) {
      if (run.rows.some((row) => row.personId === args.id)) {
        throw new ConvexError("That person is in a saved month. End or archive them instead.");
      }
    }
    await ctx.db.delete(args.id);
    return null;
  },
});

// ── Tax and contribution lines ──────────────────────────────────────────────

const nameKey = (name: string) => name.toLowerCase();
const NAME_TAKEN = "There is already a line with that name.";
const FULL = `That is every line a company can have (${MAX_PAYROLL_LINES} at most).`;

/** The lines a line subtracts, each once: all of its own company and kind. */
function cleanLess(
  ids: readonly Id<"payrollLines">[],
  kind: PayrollKind,
  all: readonly Doc<"payrollLines">[],
): Id<"payrollLines">[] {
  const mine = new Map(all.filter((line) => line.appliesTo === kind).map((line) => [line._id, line]));
  if (!ids.every((id) => mine.has(id))) {
    throw new ConvexError("A line can subtract only other lines of the same company and kind.");
  }
  return [...new Set(ids)];
}

/** A company's lines: employees' first, each kind in the owner's order. */
export const listLines = payrollQuery({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    return (await linesOf(ctx, args.company))
      .map((line) => ({ ...presentLine(line), changedAt: changedAt(line) }))
      .sort((a, b) => KIND_ORDER[a.appliesTo] - KIND_ORDER[b.appliesTo] || a.order - b.order);
  },
});

export const createLine = payrollMutation({
  args: {
    company: companyValidator,
    appliesTo: payrollKindValidator,
    name: v.string(),
    paidBy: payerValidator,
    /** Basis points. Left out, the line is "rate not set" and is not computed. */
    rateBp: v.optional(v.number()),
    lessLineIds: v.optional(v.array(v.id("payrollLines"))),
    allowance: v.optional(v.number()),
    baseCap: v.optional(v.number()),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const name = cleanName(args.name, "line");
    const rateBp = args.rateBp === undefined ? undefined : cleanRate(args.rateBp);
    const allowance = cleanAmount(args.allowance ?? 0, "allowance");
    const baseCap = args.baseCap === undefined ? undefined : cleanAmount(args.baseCap, "cap");

    const all = await linesOf(ctx, args.company);
    const kind = all.filter((line) => line.appliesTo === args.appliesTo);
    if (kind.some((line) => nameKey(line.name) === nameKey(name))) throw new ConvexError(NAME_TAKEN);
    if (all.length >= MAX_PAYROLL_LINES) throw new ConvexError(FULL);
    // A new line is named by nothing yet, so it cannot close a circle.
    const lessLineIds = cleanLess(args.lessLineIds ?? [], args.appliesTo, all);

    return await ctx.db.insert("payrollLines", {
      company: args.company,
      appliesTo: args.appliesTo,
      name,
      paidBy: args.paidBy,
      rateBp,
      lessLineIds,
      allowance,
      baseCap,
      order: kind.reduce((last, line) => Math.max(last, line.order + 1), 0),
      active: args.active ?? true,
    });
  },
});

/**
 * Edit a line. A rate and a cap are cleared with null. Nothing saved changes:
 * a month already prepared keeps the rate it was prepared with until its
 * draft is recalculated.
 */
export const updateLine = payrollMutation({
  args: {
    id: v.id("payrollLines"),
    name: v.optional(v.string()),
    paidBy: v.optional(payerValidator),
    rateBp: v.optional(v.union(v.number(), v.null())),
    lessLineIds: v.optional(v.array(v.id("payrollLines"))),
    allowance: v.optional(v.number()),
    baseCap: v.optional(v.union(v.number(), v.null())),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) throw new ConvexError("That line no longer exists.");
    requireCompany(ctx.member, current.company);
    const all = await linesOf(ctx, current.company);

    let name = current.name;
    if (args.name !== undefined) {
      name = cleanName(args.name, "line");
      const taken = all.some(
        (line) =>
          line._id !== args.id &&
          line.appliesTo === current.appliesTo &&
          nameKey(line.name) === nameKey(name),
      );
      if (taken) throw new ConvexError(NAME_TAKEN);
    }

    let lessLineIds = current.lessLineIds;
    if (args.lessLineIds !== undefined) {
      lessLineIds = cleanLess(args.lessLineIds, current.appliesTo, all);
      const graph = all.map((line) => ({
        id: line._id as string,
        lessLineIds: line._id === args.id ? lessLineIds : line.lessLineIds,
      }));
      if (findCycle(graph) !== null) throw new ConvexError(CYCLE_MESSAGE);
    }

    await ctx.db.patch(args.id, {
      name,
      ...(args.paidBy !== undefined ? { paidBy: args.paidBy } : null),
      rateBp: replaced(args.rateBp, current.rateBp, cleanRate),
      lessLineIds,
      ...(args.allowance !== undefined
        ? { allowance: cleanAmount(args.allowance, "allowance") }
        : null),
      baseCap: replaced(args.baseCap, current.baseCap, (cap) => cleanAmount(cap, "cap")),
      ...(args.active !== undefined ? { active: args.active } : null),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Set the order of one kind's lines: every one of them, each once. */
export const reorderLines = payrollMutation({
  args: {
    company: companyValidator,
    appliesTo: payrollKindValidator,
    ids: v.array(v.id("payrollLines")),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const mine = (await linesOf(ctx, args.company)).filter(
      (line) => line.appliesTo === args.appliesTo,
    );
    const known = new Set<string>(mine.map((line) => line._id));
    const exact =
      args.ids.length === mine.length &&
      new Set(args.ids).size === args.ids.length &&
      args.ids.every((id) => known.has(id));
    if (!exact) throw new ConvexError("Those are not this kind's lines. Reload and try again.");
    const now = Date.now();
    await Promise.all(args.ids.map((id, order) => ctx.db.patch(id, { order, updatedAt: now })));
    return null;
  },
});

/**
 * Delete a line, and take it out of the lines that subtracted it. A saved
 * month keeps its copy. Removing one already gone does nothing.
 */
export const removeLine = payrollMutation({
  args: { id: v.id("payrollLines") },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) return null;
    requireCompany(ctx.member, current.company);
    for (const line of await linesOf(ctx, current.company)) {
      if (line.lessLineIds.includes(args.id)) {
        await ctx.db.patch(line._id, {
          lessLineIds: line.lessLineIds.filter((id) => id !== args.id),
          updatedAt: Date.now(),
        });
      }
    }
    await ctx.db.delete(args.id);
    return null;
  },
});

// The usual names, for the owner to fill in. Names and who pays, and that is
// all: no rate, base, allowance or cap is ever suggested, because what they
// are is the owner's to confirm with an accountant, not this file's to know.
const USUAL_LINES: Record<CompanyId, readonly (readonly [string, "employee" | "company"])[]> = {
  kz: [
    ["ОПВ · pension contribution", "employee"],
    ["ИПН · income tax", "employee"],
    ["ВОСМС · medical insurance contribution", "employee"],
    ["СО · social contributions", "company"],
    ["СН · social tax", "company"],
    ["ООСМС · employer medical insurance", "company"],
    ["ОПВР · employer pension contribution", "company"],
  ],
  us: [
    ["Federal income tax withholding", "employee"],
    ["Social Security (employee)", "employee"],
    ["Medicare (employee)", "employee"],
    ["Social Security (employer)", "company"],
    ["Medicare (employer)", "company"],
    ["FUTA", "company"],
    ["State unemployment", "company"],
  ],
};

/**
 * Add the company's usual line names for employees or for contractors (the
 * same names: each kind keeps its own rates), each with no rate, after the
 * lines already there. A name already present for that kind is left as it
 * is. Returns how many were added.
 */
export const addUsualLines = payrollMutation({
  args: {
    company: companyValidator,
    appliesTo: v.optional(v.union(v.literal("employee"), v.literal("contractor"))),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const kind = args.appliesTo ?? "employee";
    const all = await linesOf(ctx, args.company);
    const employees = all.filter((line) => line.appliesTo === kind);
    const present = new Set(employees.map((line) => nameKey(line.name)));
    const missing = USUAL_LINES[args.company].filter(([name]) => !present.has(nameKey(name)));
    if (all.length + missing.length > MAX_PAYROLL_LINES) throw new ConvexError(FULL);
    const first = employees.reduce((last, line) => Math.max(last, line.order + 1), 0);
    for (const [index, [name, paidBy]] of missing.entries()) {
      await ctx.db.insert("payrollLines", {
        company: args.company,
        appliesTo: kind,
        name,
        paidBy,
        lessLineIds: [],
        allowance: 0,
        order: first + index,
        active: true,
      });
    }
    return missing.length;
  },
});

// ── Months ──────────────────────────────────────────────────────────────────

const NOTHING_SAVED = "Nothing is saved for that month.";
const PAID = "That month is marked paid. Reopen it to change it.";
const NOT_IN_MONTH = "That person is not in this month.";

function presentRun(run: Doc<"payrollRuns">) {
  return {
    month: run.month,
    status: run.status,
    paidOn: run.paidOn ?? null,
    preparedAt: run.preparedAt,
  };
}

/** A company's saved month with its totals, or null where none is saved. */
export const getRun = payrollQuery({
  args: { company: companyValidator, month: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    // A month that is no month has nothing saved; a refused query would break the page.
    if (!isCanonicalPeriodStart("month", args.month)) return null;
    const run = await runOf(ctx, args.company, args.month);
    if (run === null) return null;
    return {
      ...presentRun(run),
      rows: run.rows.map(readRow),
      totals: totalsOf(run.rows, MARKET_CURRENCY[args.company]),
    };
  },
});

/** A company's saved months, newest first, each with its totals. */
export const listRuns = payrollQuery({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const runs = await ctx.db
      .query("payrollRuns")
      .withIndex("by_company_and_month", (q) => q.eq("company", args.company))
      .order("desc")
      .take(MAX_RUNS_LISTED);
    return runs.map((run) => ({
      ...presentRun(run),
      people: run.rows.length,
      totals: totalsOf(run.rows, MARKET_CURRENCY[args.company]),
    }));
  },
});

type Adjustments = Map<Id<"payrollPeople">, { amount: number; note?: string }>;

/** The adjustments a saved month holds, by person. */
const adjustmentsOf = (run: Doc<"payrollRuns"> | null): Adjustments =>
  new Map(
    (run?.rows ?? []).flatMap((row) =>
      row.adjustment === undefined
        ? []
        : [[row.personId, { amount: row.adjustment, note: row.adjustmentNote }] as const],
    ),
  );

const NOBODY = "Nobody is on the payroll in that month.";

/**
 * A month's rows worked out now: the people active in it, each with the
 * lines and rates as they are, and the adjustments given. The same arithmetic
 * the page shows a month that is not paid with, so what is saved is what was
 * seen.
 */
async function rowsNow(
  ctx: QueryCtx,
  company: CompanyId,
  month: string,
  adjustments: Adjustments,
): Promise<Row[]> {
  const people = (await peopleOf(ctx, company))
    .map(presentPerson)
    .filter((person) => activeIn(person, month));
  if (people.length === 0) throw new ConvexError(NOBODY);
  const lines = (await linesOf(ctx, company)).map(presentLine);
  const cells = people.reduce((sum, person) => sum + linesFor(lines, person.kind).length, 0);
  if (cells > MAX_RUN_CELLS) {
    throw new ConvexError(
      "That month is too large to save. Switch off lines that are not used, or end people who have left.",
    );
  }
  try {
    return draftRows({
      people,
      lines,
      month,
      companyCurrency: MARKET_CURRENCY[company],
      adjustments,
    });
  } catch (error) {
    // Every write refuses a circle, so this is a stored one from elsewhere.
    if (error instanceof PayrollCycleError) throw new ConvexError(CYCLE_MESSAGE);
    throw error;
  }
}

/** Save rows as a month's, a draft or paid, over whatever was saved for it before. */
async function saveRun(
  ctx: MutationCtx,
  company: CompanyId,
  month: string,
  existing: Doc<"payrollRuns"> | null,
  fields: { rows: Row[]; status: "draft" | "paid"; paidOn?: string },
) {
  const preparedAt = Date.now();
  if (existing === null) {
    await ctx.db.insert("payrollRuns", { company, month, preparedAt, ...fields });
  } else {
    await ctx.db.patch(existing._id, { preparedAt, ...fields });
  }
}

/**
 * Save a month as a draft, or recalculate its draft: the people active in
 * the month, each with the lines and rates as they are now, keeping each
 * person's adjustment. A paid month is refused. The page does not call it:
 * a month that is not paid is shown worked out live, and `markPaid` freezes
 * it in one step.
 */
export const prepareRun = payrollMutation({
  args: { company: companyValidator, month: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const month = checkMonth(args.month);
    const existing = await runOf(ctx, args.company, month);
    if (existing?.status === "paid") throw new ConvexError(PAID);
    const rows = await rowsNow(ctx, args.company, month, adjustmentsOf(existing));
    await saveRun(ctx, args.company, month, existing, { rows, status: "draft" });
    return null;
  },
});

/**
 * A one-off bonus (above zero) or deduction (below) for one person in a
 * month that is not paid, in their currency's minor unit. Zero clears it. It
 * is added after the lines, so it moves net and cost and no line's base.
 *
 * Adjustments are kept on the month's draft. Setting one saves the draft
 * again from today's people and lines with it in, so what is stored is what
 * the page shows; no draft is needed beforehand.
 */
export const setAdjustment = payrollMutation({
  args: {
    company: companyValidator,
    month: v.string(),
    personId: v.id("payrollPeople"),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const month = checkMonth(args.month);
    const existing = await runOf(ctx, args.company, month);
    if (existing?.status === "paid") throw new ConvexError(PAID);
    if (!Number.isSafeInteger(args.amount)) {
      throw new ConvexError("An adjustment must be a whole amount.");
    }
    if (Math.abs(args.amount) > MAX_PAYROLL_AMOUNT) {
      throw new ConvexError("That adjustment is too large.");
    }
    const note = cleanLine(
      args.note ?? "",
      MAX_PAYROLL_NOTE_LENGTH,
      tooLong("note", MAX_PAYROLL_NOTE_LENGTH),
    );
    const adjustments = adjustmentsOf(existing);
    adjustments.delete(args.personId);
    if (args.amount !== 0) {
      adjustments.set(args.personId, { amount: args.amount, ...(note !== "" ? { note } : null) });
    }
    let rows: Row[];
    try {
      rows = await rowsNow(ctx, args.company, month, adjustments);
    } catch (error) {
      if (error instanceof ConvexError && error.data === NOBODY) {
        throw new ConvexError(NOT_IN_MONTH);
      }
      throw error;
    }
    const row = rows.find((candidate) => candidate.personId === args.personId);
    if (row === undefined) throw new ConvexError(NOT_IN_MONTH);
    // With no gross worked out, the net entered is all there is to hold it to.
    if ((row.gross ?? row.targetNet ?? 0) + args.amount < 0) {
      throw new ConvexError("A deduction cannot be more than the month's gross.");
    }
    await saveRun(ctx, args.company, month, existing, { rows, status: "draft" });
    return null;
  },
});

/**
 * Mark a month paid on a date, which freezes it: its rows are worked out at
 * this moment from today's people and lines, keeping each adjustment, and
 * saved with the date, whether or not a draft was saved before. Refused while
 * any line has no amount, and then nothing is written: a missing figure is
 * not a zero, and a month is not paid on one.
 */
export const markPaid = payrollMutation({
  args: { company: companyValidator, month: v.string(), paidOn: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const month = checkMonth(args.month);
    const existing = await runOf(ctx, args.company, month);
    if (existing?.status === "paid") throw new ConvexError(PAID);
    if (!isCanonicalPeriodStart("day", args.paidOn)) {
      throw new ConvexError("The payment date is not a date.");
    }
    const rows = await rowsNow(ctx, args.company, month, adjustmentsOf(existing));
    if (rows.some((row) => row.gross === undefined || rowSums(row).notComputed > 0)) {
      throw new ConvexError(
        "Some lines have no amount. Set each rate or switch the line off, then mark the month paid.",
      );
    }
    await saveRun(ctx, args.company, month, existing, {
      rows,
      status: "paid",
      paidOn: args.paidOn,
    });
    return null;
  },
});

/** Make a paid month a draft again. Its numbers stay until it is recalculated. */
export const reopenRun = payrollMutation({
  args: { company: companyValidator, month: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const run = await runOf(ctx, args.company, checkMonth(args.month));
    if (run === null) throw new ConvexError(NOTHING_SAVED);
    if (run.status === "paid") await ctx.db.patch(run._id, { status: "draft", paidOn: undefined });
    return null;
  },
});

/** Delete a draft month. A paid one is refused; one already gone does nothing. */
export const removeRun = payrollMutation({
  args: { company: companyValidator, month: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const run = await runOf(ctx, args.company, checkMonth(args.month));
    if (run === null) return null;
    if (run.status === "paid") {
      throw new ConvexError("A paid month is not deleted. Reopen it first.");
    }
    await ctx.db.delete(run._id);
    return null;
  },
});
