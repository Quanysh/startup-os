// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { countLines, parseCounts } from "./counts";
import { ENV_BACKUP, ENV_LOCAL, planSwap, readEnvFiles, swapEnvLocal } from "./envSwap";

const LOCAL = "CONVEX_DEPLOYMENT=anonymous:anonymous-agent\nNEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210\n";
// A made-up cloud configuration, as a developer with a Convex account has.
const CLOUD =
  "CONVEX_DEPLOYMENT=dev:happy-animal-123 # team: example, project: example\nNEXT_PUBLIC_CONVEX_URL=https://happy-animal-123.convex.cloud\n";

describe("what to do with .env.local before the local backend starts", () => {
  test("none there, none kept: nothing to do", () => {
    expect(planSwap({ envLocal: null, backup: false })).toEqual({ action: "none", restore: false });
  });

  test("a local one: leave it", () => {
    expect(planSwap({ envLocal: LOCAL, backup: false })).toEqual({ action: "none", restore: false });
  });

  test("a cloud one: set it aside, and bring it back at the end", () => {
    expect(planSwap({ envLocal: CLOUD, backup: false })).toEqual({ action: "set_aside", restore: true });
  });

  test("a cloud one left aside by a run that was killed: leave it, and bring it back at the end", () => {
    expect(planSwap({ envLocal: LOCAL, backup: true })).toEqual({ action: "none", restore: true });
    expect(planSwap({ envLocal: null, backup: true })).toEqual({ action: "none", restore: true });
  });

  test("two cloud files: refuse rather than overwrite either", () => {
    const plan = planSwap({ envLocal: CLOUD, backup: true });
    expect(plan).toMatchObject({ action: "refuse" });
    if (plan.action === "refuse") {
      expect(plan.reason).toContain(".env.local.cloud");
      expect(plan.reason).not.toContain("happy-animal");
    }
  });
});

describe("the swap on disk", () => {
  let root: string;
  const at = (name: string) => join(root, name);
  const text = (name: string) => (existsSync(at(name)) ? readFileSync(at(name), "utf8") : null);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "startup-os-swap-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a cloud .env.local is moved aside whole, and comes back whole over the local one", () => {
    writeFileSync(at(ENV_LOCAL), CLOUD);
    const swap = swapEnvLocal(root);
    if (!swap.ok) throw new Error(swap.reason);
    expect(swap.kept).toBe(true);
    expect(text(ENV_LOCAL)).toBeNull();
    expect(text(ENV_BACKUP)).toBe(CLOUD);

    writeFileSync(at(ENV_LOCAL), LOCAL); // what the CLI writes while it runs
    swap.restore();
    expect(text(ENV_LOCAL)).toBe(CLOUD);
    expect(text(ENV_BACKUP)).toBeNull();
  });

  test("restoring twice does nothing the second time", () => {
    writeFileSync(at(ENV_LOCAL), CLOUD);
    const swap = swapEnvLocal(root);
    if (!swap.ok) throw new Error(swap.reason);
    swap.restore();
    writeFileSync(at(ENV_LOCAL), "CHANGED_SINCE=1\n");
    swap.restore();
    expect(text(ENV_LOCAL)).toBe("CHANGED_SINCE=1\n");
  });

  test("a local .env.local is not touched, before or after", () => {
    writeFileSync(at(ENV_LOCAL), LOCAL);
    const swap = swapEnvLocal(root);
    if (!swap.ok) throw new Error(swap.reason);
    expect(swap.kept).toBe(false);
    swap.restore();
    expect(text(ENV_LOCAL)).toBe(LOCAL);
    expect(text(ENV_BACKUP)).toBeNull();
  });

  test("a fresh checkout stays as the CLI leaves it", () => {
    const swap = swapEnvLocal(root);
    if (!swap.ok) throw new Error(swap.reason);
    writeFileSync(at(ENV_LOCAL), LOCAL);
    swap.restore();
    expect(text(ENV_LOCAL)).toBe(LOCAL);
  });

  test("after a run that was killed, the next one brings the cloud file back", () => {
    writeFileSync(at(ENV_LOCAL), LOCAL);
    writeFileSync(at(ENV_BACKUP), CLOUD);
    const swap = swapEnvLocal(root);
    if (!swap.ok) throw new Error(swap.reason);
    expect(swap.kept).toBe(true);
    expect(text(ENV_LOCAL)).toBe(LOCAL);
    swap.restore();
    expect(text(ENV_LOCAL)).toBe(CLOUD);
    expect(text(ENV_BACKUP)).toBeNull();
  });

  test("two cloud files: nothing is moved", () => {
    writeFileSync(at(ENV_LOCAL), CLOUD);
    writeFileSync(at(ENV_BACKUP), CLOUD.replace("dev:", "prod:"));
    expect(swapEnvLocal(root).ok).toBe(false);
    expect(text(ENV_LOCAL)).toBe(CLOUD);
    expect(text(ENV_BACKUP)).toContain("prod:");
  });

  test("the files are read as the guard wants them", () => {
    expect(readEnvFiles(root)).toEqual({ envLocal: null, env: null });
    writeFileSync(at(ENV_LOCAL), LOCAL);
    writeFileSync(at(".env"), "A=1\n");
    expect(readEnvFiles(root)).toEqual({ envLocal: LOCAL, env: "A=1\n" });
  });
});

describe("what the seed reports", () => {
  test("the counts out of what the CLI printed, in a column, by table name", () => {
    const counts = parseCounts(`A notice.\n{\n  "tasks": 16,\n  "deals": 19,\n  "metricSnapshots": 1204\n}\n`);
    expect(counts).toEqual({ tasks: 16, deals: 19, metricSnapshots: 1204 });
    expect(countLines(counts!)).toEqual([
      "  deals               19",
      "  metricSnapshots   1204",
      "  tasks               16",
    ]);
  });

  test.each(["", "not json", "[]", "{}", '{"tasks":"many"}'])("%j is no report", (output) => {
    expect(parseCounts(output)).toBeNull();
  });
});
