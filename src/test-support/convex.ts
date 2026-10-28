import { useMutation, useQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { vi, type Mock } from "vitest";

type AnyRef = FunctionReference<"query" | "mutation">;

/**
 * Stand-ins for Convex's React hooks in component tests. The test file must
 * itself declare the module mock, because vi.mock is hoisted per file:
 *
 *   vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
 *
 * Queries return whatever was last set for them; change a value and re-render
 * to play a live update. A query asked more than once with different arguments
 * can be answered by its arguments (`setQueryBy`). Mutations are vi.fn()s that resolve to null unless
 * given another implementation.
 */
export function mockConvex() {
  const queries = new Map<string, unknown>();
  const answers = new Map<string, (args: unknown) => unknown>();
  const mutations = new Map<string, Mock>();
  const mutationFor = (name: string) => {
    if (!mutations.has(name)) mutations.set(name, vi.fn(async () => null));
    return mutations.get(name)!;
  };

  vi.mocked(useQuery).mockImplementation(((ref: AnyRef, args?: unknown) =>
    args === "skip"
      ? undefined
      : answers.has(getFunctionName(ref))
        ? answers.get(getFunctionName(ref))!(args)
        : queries.get(getFunctionName(ref))) as never);
  vi.mocked(useMutation).mockImplementation(((ref: AnyRef) => {
    const call = (...args: unknown[]) => mutationFor(getFunctionName(ref))(...args);
    return Object.assign(call, { withOptimisticUpdate: () => call });
  }) as never);

  return {
    setQuery: (ref: AnyRef, value: unknown) => queries.set(getFunctionName(ref), value),
    /** Answer a query from its arguments. Takes precedence over `setQuery`. */
    setQueryBy: (ref: AnyRef, answer: (args: unknown) => unknown) =>
      answers.set(getFunctionName(ref), answer),
    mutation: (ref: AnyRef) => mutationFor(getFunctionName(ref)),
  };
}

/** A promise the test settles by hand, to hold a mutation "in flight". */
export function deferred<T = null>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
