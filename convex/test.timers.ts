import { vi } from "vitest";
import type { TestBackend } from "./test.setup";

// For tests that fake setTimeout. A connector's request helper pauses before
// its one retry, and under fake timers nothing moves that pause along: the
// awaited work would wait for ever. These keep the fake clock turning until
// the work is done. (The two-dot filename keeps Convex from bundling this.)

/** Await `work` while fake timers are advanced underneath it. */
export async function whileTimersRun<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  // Handled below by the final await; this only stops an early rejection
  // from being reported as unhandled while the loop is still turning.
  watched.catch(() => {});
  while (!settled) await vi.advanceTimersByTimeAsync(300);
  return watched;
}

/** Run every scheduled function to completion, retries and all. */
export function finishScheduled(t: TestBackend): Promise<void> {
  return whileTimersRun(t.finishAllScheduledFunctions(vi.runAllTimers));
}
