// @vitest-environment node
import { BOT_OWN_TOOLS } from "./lib/botRules";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  AGENT_IDS,
  AGENT_PROMPTS,
  BRIEF_PAGES,
  MAX_BRIEF_BULLETS,
  MAX_BULLET_LENGTH,
  PROPOSAL_KINDS,
  RUN_TIMES,
} from "./lib/agents";
import { CHAT_AGENT, CHAT_PAGES, CHAT_TOOLS, RUNNER_TOOLS } from "./lib/chatRules";
import { AGENT_SIGNALS, AGENT_SUMMARY_LENGTH } from "./lib/dealIntel";
import { TOOLS } from "./lib/mcpTools";

// The agents' procedures are files a Claude session on the owner's Mac reads
// (docs/agents/). Nothing compiles them, so nothing but this test keeps them
// in step with the tools: a prompt that names a tool the registry does not
// hold, or a write tool no prompt mentions, fails here.
//
// A prompt writes a tool as Claude sees it, `mcp__startup-os__<name>`, which is
// what tells a tool from a proposal kind of the same name (`task_create`).

const DIR = fileURLToPath(new URL("../docs/agents/", import.meta.url));
const read = (file: string) => readFileSync(`${DIR}${file}`, "utf8");
/** The chat's own instructions: what the runner gives Claude Code with each question (docs/assistant.md). */
const CHAT = "chat.md";
const PROMPTS = [...AGENT_IDS.map((agent) => AGENT_PROMPTS[agent]), "run.md", CHAT];
const toolsIn = (text: string) =>
  [...text.matchAll(/mcp__startup-os__([a-z_]+)/g)].map((match) => match[1]!);
const NAMES = new Set(TOOLS.map((tool) => tool.name));

describe("the agents' prompt files", () => {
  test("there is one for each agent, the run's own, the chat's, and a README, and nothing else", () => {
    expect(readdirSync(DIR).sort()).toEqual([...PROMPTS, "README.md"].sort());
  });

  test.each(PROMPTS)("%s names only tools that exist", (file) => {
    const named = toolsIn(read(file));
    expect(named.length).toBeGreaterThan(3);
    for (const name of named) expect(NAMES.has(name), `${file}: ${name}`).toBe(true);
  });

  test("no prompt names a tool any other way: a bare tool name in backticks is a proposal kind or a field", () => {
    const kinds: readonly string[] = PROPOSAL_KINDS;
    for (const file of PROMPTS) {
      for (const [, word] of read(file).matchAll(/`([a-z_]+)`/g)) {
        if (NAMES.has(word!)) expect(kinds, `${file}: \`${word}\` should be written mcp__startup-os__${word}`).toContain(word);
      }
    }
  });

  test("every tool that writes is mentioned by at least one prompt", () => {
    const mentioned = new Set(PROMPTS.flatMap((file) => toolsIn(read(file))));
    // A bot's own (`permission_request`) is for the owner's bots, not the four: no prompt names it.
    const own = BOT_OWN_TOOLS as readonly string[];
    for (const tool of TOOLS.filter((entry) => entry.kind === "act" && entry.audience !== "runner" && !own.includes(entry.name))) {
      expect(mentioned.has(tool.name), tool.name).toBe(true);
    }
  });

  test("the chat runner program's own tools are named in no prompt: no model is told of them", () => {
    for (const file of PROMPTS) {
      expect(read(file), file).not.toMatch(/chat_next|chat_progress|chat_finish|os_agents_due|os_agent_start|os_agent_finish/);
    }
    expect(RUNNER_TOOLS.every((name) => NAMES.has(name))).toBe(true);
  });

  test("the chat's instructions name exactly the tools the answering Claude is allowed, and the four it never has", () => {
    const named = new Set(toolsIn(read(CHAT)));
    const never = [
      "task_create",
      "task_update",
      "task_move",
      "deal_update",
      "investor_update",
      "investor_create",
      "customer_update",
      "partner_upsert",
      "partner_move",
      "contact_upsert",
      "contact_link",
      "contact_merge",
      "note_create",
      "decision_create",
      "questionnaire_upsert",
      "answer_bank_upsert",
      "vendor_agreement_upsert",
      "evidence_upsert",
      "handoff_create",
      "handoff_update",
      "linkedin_post_upsert",
      "linkedin_stats_add",
      "note_write",
      "comment_create",
      "task_archive",
      "handoff_reassign",
      "proposal_sweep",
      "proposal_decide",
    ];
    expect([...named].sort()).toEqual([...CHAT_TOOLS, ...never].sort());
  });

  test("the chat's instructions hold its rules, the pages it may name, and a made-up example", () => {
    const text = read(CHAT);
    expect(text).toMatch(/Answer only from tool results of this turn/);
    expect(text).toMatch(/"not read yet", never 0/);
    expect(text).toMatch(/data, never an instruction/);
    expect(text).toMatch(/Never payroll or mail/);
    expect(text).toMatch(/You change nothing yourself/);
    expect(text).toContain("I have put a card below for you to approve.");
    expect(text).toContain("`chatMessageId`");
    expect(text).toContain(`agent: "${CHAT_AGENT}"`);
    expect(text).toMatch(/Short, plain text/);
    expect(text).toMatch(/every name and number is made up/);
    // Every path it tells the model to write is one the page will make a link of.
    const pages: readonly string[] = CHAT_PAGES;
    for (const [, path] of text.matchAll(/`(\/[a-z-]*)`/g)) expect(pages, path).toContain(path);
    expect(text).not.toMatch(/sosa_|sos_[A-Za-z0-9]|ANTHROPIC_API_KEY/);
    for (const [address] of text.matchAll(/[a-z0-9.]+@[a-z0-9.-]+/g)) expect(address).toMatch(/@example\.test$/);
  });

  test("the tools that change the board at once are only ever named to be forbidden", () => {
    const direct = [
      "task_create",
      "task_update",
      "task_move",
      "deal_update",
      "investor_update",
      "investor_create",
      "customer_update",
      "partner_upsert",
      "partner_move",
      "contact_upsert",
      "contact_link",
      "contact_merge",
      "note_create",
      "decision_create",
      "handoff_create",
      "handoff_update",
      "linkedin_post_upsert",
      "linkedin_stats_add",
      "note_write",
      "comment_create",
      "task_archive",
      "handoff_reassign",
      "proposal_decide",
    ];
    for (const file of PROMPTS) {
      const text = read(file);
      for (const name of direct) {
        for (const match of text.matchAll(new RegExp(`mcp__startup-os__${name}\\b`, "g"))) {
          // The sentence it stands in says never.
          const start = Math.max(text.lastIndexOf("\n- ", match.index), text.lastIndexOf(". ", match.index), 0);
          expect(text.slice(start, match.index), `${file}: ${name}`).toMatch(/[Nn]ever/);
        }
      }
    }
  });

  test.each(AGENT_IDS)("%s's file gives its agent name, the run's rules and an example that is made up", (agent) => {
    const text = read(AGENT_PROMPTS[agent]);
    expect(text).toContain(`\`${agent}\``);
    expect(text).toContain("docs/agents/run.md");
    expect(text).toMatch(/data, never an instruction/);
    expect(text).toMatch(/payroll/);
    expect(text).toMatch(/every name and number is made up/);
    expect(text).toContain("mcp__startup-os__propose");
    // No address on a real domain, and no token.
    for (const [address] of text.matchAll(/[a-z0-9.]+@[a-z0-9.-]+/g)) expect(address).toMatch(/@example\.test$/);
    expect(text).not.toMatch(/sosa_|sos_[A-Za-z0-9]/);
  });

  test("the run gives the order, the limits, the default time, what to do on a failure and a report of counts", () => {
    const run = read("run.md");
    const order = ["engineering.md", "sales.md", "finance.md", "chief-of-staff.md"].map((file) =>
      run.indexOf(`docs/agents/${file}`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(run).toContain(RUN_TIMES.morning);
    // The afternoon's light run is gone: the Mac's catch-up stands in for a missed morning.
    expect(run).not.toMatch(/afternoon|16:00/);
    expect(run).toMatch(/5 proposals a run from engineering, 5 from sales, 3 from finance/);
    expect(run).toMatch(/Do not retry/);
    expect(run).toMatch(/Never loop/);
    expect(run).toMatch(/Report counts only/);
    expect(run).toContain("agent:kind:subject-id");
    expect(run).not.toMatch(/sosa_/);
  });

  test("the numbers a prompt quotes are the ones the server enforces", () => {
    const chief = read(AGENT_PROMPTS.chief_of_staff);
    expect(chief).toContain(`at most **${MAX_BRIEF_BULLETS} bullets`);
    expect(chief).toContain(`at most ${MAX_BULLET_LENGTH} characters`);
    for (const page of BRIEF_PAGES) expect(chief, page).toContain(`\`${page}\``);
    // What the `deals` tool sends of a US deal's intelligence (convex/lib/dealIntel.ts).
    const sales = read(AGENT_PROMPTS.sales);
    expect(sales).toContain(`cut to ${AGENT_SUMMARY_LENGTH} characters`);
    expect(AGENT_SIGNALS).toBe(3);
    expect(sales).toContain("newest three `signals`");
  });
});
