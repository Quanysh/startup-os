// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MirrorStatus, type MirrorSource } from "./mirror-status";

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);
const base: MirrorSource = { configured: true, missingEnv: [], status: null };
const ok = (hoursAgo: number): MirrorSource => ({
  ...base,
  status: {
    state: "ok",
    message: null,
    lastRunAt: NOW - hoursAgo * HOUR,
    lastOkAt: NOW - hoursAgo * HOUR,
  },
});
const show = (source: MirrorSource | undefined) =>
  render(<MirrorStatus named="the Kazakhstan CRM" source={source} />);

describe("MirrorStatus", () => {
  test("says nothing while loading", () => {
    const { container } = show(undefined);
    expect(container.textContent).toBe("");
  });

  test("not connected: names the variable to set", () => {
    show({ configured: false, missingEnv: ["INGEST_TOKEN_KZ_CRM"], status: null });
    expect(
      screen.getByText(
        "Not connected to the Kazakhstan CRM yet. Set INGEST_TOKEN_KZ_CRM on the Convex deployment, then run the routine in docs/ingest.md.",
      ),
    ).toBeTruthy();
  });

  test("connected, before the first push", () => {
    show(base);
    expect(
      screen.getByText("Connected. Waiting for the first push from the Kazakhstan CRM."),
    ).toBeTruthy();
  });

  // Until 2026-10-15 these said "read 2h ago" and "may be behind": when it was
  // read, and whether that is late, is now the page header's, said once.
  test("read, recently or long ago: nothing here, the header says when", () => {
    for (const hours of [2, 72, 5 * 24]) {
      const { container } = show(ok(hours));
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  test("a refused push shows its reason, and not again how old the board is", () => {
    const { container } = show({
      ...base,
      status: {
        state: "error",
        message: "invalid_rows: deals.1.closedAt — Only a won or lost deal has a close date.",
        lastRunAt: NOW - HOUR,
        lastOkAt: NOW - 26 * HOUR,
      },
    });
    expect(container.textContent).toBe(
      "The last push from the Kazakhstan CRM was refused: invalid_rows: deals.1.closedAt — Only a won or lost deal has a close date.",
    );
  });

  test("a refused first push", () => {
    const { container } = show({
      ...base,
      status: { state: "error", message: "invalid_json", lastRunAt: NOW, lastOkAt: null },
    });
    expect(container.textContent).toBe(
      "The last push from the Kazakhstan CRM was refused: invalid_json.",
    );
  });
});
