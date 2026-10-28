// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import {
  METRICS,
  SCOPE_CURRENCY,
  SCOPE_LABELS,
  metricScopes,
} from "@convex/lib/metricRegistry";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { formatValue } from "@/lib/format";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import { TargetsEditor } from "./targets-editor";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The first number on the scorecard, in its first scope: whatever the registry says it is.
const METRIC = METRICS.filter((m) => m.home !== undefined).sort(
  (a, b) => (a.home ?? 0) - (b.home ?? 0),
)[0]!;
const SCOPE = metricScopes(METRIC)[0]!;
const LABEL = `${METRIC.label} · ${SCOPE_LABELS[SCOPE]}`;
const CURRENCY = METRIC.unit === "currency" ? SCOPE_CURRENCY[SCOPE] : undefined;

let convex: ReturnType<typeof mockConvex>;
const table = () => screen.getByRole("table", { name: "Targets" });
const firstRow = () => within(table()).getAllByRole("row")[1]!;
const field = () =>
  within(firstRow()).getByRole("spinbutton", { name: new RegExp(`^New target for ${LABEL}`) });

beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.targets.list, []);
});
afterEach(cleanup);

// A teammate who was given "Sources and Telegram" sets targets for their own
// companies. The server refuses any other; the table does not list them.
describe("TargetsEditor for a teammate on one company", () => {
  const scopes = (companies: CompanyId[]) => {
    render(
      <ViewerProvider
        viewer={{ role: "engineer", companies, areas: ["settings"], email: null, name: null }}
      >
        <TargetsEditor />
      </ViewerProvider>,
    );
    return within(table())
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]!.textContent);
  };
  const US = [SCOPE_LABELS.us, SCOPE_LABELS.startup_insights, SCOPE_LABELS.vertical_startup];
  const KZ = [SCOPE_LABELS.kz, SCOPE_LABELS.kz_product];

  test("on Globex: no row of Startup's", () => {
    const listed = scopes(["kz"]);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((scope) => US.includes(scope as string))).toBe(false);
    expect(listed.some((scope) => KZ.includes(scope as string))).toBe(true);
  });

  test("on Startup: no row of Globex's", () => {
    const listed = scopes(["us"]);
    expect(listed.some((scope) => KZ.includes(scope as string))).toBe(false);
    expect(listed.some((scope) => US.includes(scope as string))).toBe(true);
  });
});

describe("TargetsEditor", () => {
  test("until the targets are in there is a placeholder and no table", () => {
    convex.setQuery(api.targets.list, undefined);
    render(<TargetsEditor />);
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("each scorecard number is a row: its scope, its target, what it is per, and a field to set one", () => {
    convex.setQuery(api.targets.list, [{ key: METRIC.key, scope: SCOPE, target: 1234 }]);
    render(<TargetsEditor />);
    expect(within(table()).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Number",
      "Scope",
      "Target",
      "Per",
      "New target",
      "Actions",
    ]);
    const row = within(firstRow());
    expect(row.getByRole("rowheader").textContent).toBe(METRIC.label);
    const cells = row.getAllByRole("cell");
    expect(cells.slice(0, 3).map((td) => td.textContent)).toEqual([
      SCOPE_LABELS[SCOPE],
      formatValue(1234, METRIC.unit, CURRENCY),
      METRIC.grain,
    ]);
    expect(cells[1]!.className).toContain("text-right");
    expect(cells[1]!.className).toContain("font-num");
    expect(row.getByRole("button", { name: `Clear the target for ${LABEL}` })).toBeTruthy();
  });

  test("a number with no target says so, and has nothing to clear", () => {
    render(<TargetsEditor />);
    const row = within(firstRow());
    expect(row.getAllByRole("cell")[1]!.textContent).toBe("No target");
    // Kept in the row (so the columns do not shift) but disabled and out of sight.
    const clear = row.getByRole("button", { name: /^Clear/ }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(clear.className).toContain("disabled:invisible");
  });

  test("setting a target sends the number typed, and clears the field", async () => {
    const user = userEvent.setup();
    render(<TargetsEditor />);
    await user.type(field(), "250");
    await user.click(within(firstRow()).getByRole("button", { name: `Set the target for ${LABEL}` }));
    expect(convex.mutation(api.targets.set)).toHaveBeenCalledWith({
      key: METRIC.key,
      scope: SCOPE,
      target: 250,
    });
    expect((field() as HTMLInputElement).value).toBe("");
  });

  test("an empty field is refused in the row, and a refusal from the server is shown in its words", async () => {
    const user = userEvent.setup();
    render(<TargetsEditor />);
    const set = () => within(firstRow()).getByRole("button", { name: `Set the target for ${LABEL}` });
    await user.click(set());
    expect(within(firstRow()).getByRole("alert").textContent).toBe("Enter a number.");
    expect(convex.mutation(api.targets.set)).not.toHaveBeenCalled();

    convex.mutation(api.targets.set).mockRejectedValueOnce(new ConvexError("That target is out of range."));
    await user.type(field(), "5");
    await user.click(set());
    expect((await within(firstRow()).findByRole("alert")).textContent).toBe(
      "That target is out of range.",
    );
  });

  test("the download holds the targets, not the field to type a new one", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.targets.list, [{ key: METRIC.key, scope: SCOPE, target: 1234 }]);
    render(<TargetsEditor />);
    await user.type(field(), "999");
    const rows = readTable(table());
    expect(rows[0]).toEqual(["Number", "Scope", "Target", "Per"]);
    expect(rows[1]).toEqual([METRIC.label, SCOPE_LABELS[SCOPE], formatValue(1234, METRIC.unit, CURRENCY), METRIC.grain]);
  });

  test("clearing a target asks the server to", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.targets.list, [{ key: METRIC.key, scope: SCOPE, target: 1234 }]);
    render(<TargetsEditor />);
    await user.click(
      within(firstRow()).getByRole("button", { name: `Clear the target for ${LABEL}` }),
    );
    expect(convex.mutation(api.targets.clear)).toHaveBeenCalledWith({ key: METRIC.key, scope: SCOPE });
  });
});

// On Goals and targets, someone without the settings area reads the targets
// and is offered nothing to change: the server would refuse `targets.set`.
describe("TargetsEditor read-only", () => {
  test("the targets in a table, with no field and no Clear", () => {
    render(
      <ViewerProvider
        viewer={{ role: "cofounder", companies: ["us", "kz"], areas: ["scorecard"], email: null, name: null }}
      >
        <TargetsEditor />
      </ViewerProvider>,
    );
    expect(within(table()).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Number",
      "Scope",
      "Target",
      "Per",
    ]);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear/ })).toBeNull();
    // Reading is enough to download what is read.
    expect(screen.getByRole("button", { name: "Download Targets as CSV" })).toBeTruthy();
  });
});
