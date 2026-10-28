import { describe, expect, test } from "vitest";
import {
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  negotiateVersion,
  readMessage,
  rpcError,
  rpcResult,
  toolError,
  toolResult,
} from "./mcpProtocol";

describe("readMessage", () => {
  test("a request has a method and an id, a text or a whole number", () => {
    expect(readMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual({
      kind: "request",
      id: 1,
      method: "ping",
      params: undefined,
    });
    expect(readMessage({ jsonrpc: "2.0", id: "a", method: "tools/list", params: { cursor: "x" } })).toEqual({
      kind: "request",
      id: "a",
      method: "tools/list",
      params: { cursor: "x" },
    });
    expect(readMessage({ jsonrpc: "2.0", id: 0, method: "ping" }).kind).toBe("request");
  });

  test("with no id it is a notification", () => {
    expect(readMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      kind: "notification",
    });
  });

  test("an answer to a request is taken like one", () => {
    expect(readMessage({ jsonrpc: "2.0", id: 4, result: {} }).kind).toBe("notification");
    expect(readMessage({ jsonrpc: "2.0", id: 4, error: { code: 1, message: "x" } }).kind).toBe("notification");
  });

  test("an array is a batch", () => {
    expect(readMessage([])).toEqual({ kind: "batch" });
    expect(readMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toEqual({ kind: "batch" });
  });

  test("params that are not an object are bad params, with the request's id", () => {
    expect(readMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: [1] })).toEqual({
      kind: "bad_params",
      id: 7,
    });
    expect(readMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: null }).kind).toBe("bad_params");
  });

  test.each([
    [null],
    ["text"],
    [7],
    [{}],
    [{ jsonrpc: "2.0" }],
    [{ jsonrpc: "2.0", id: 1 }],
    [{ jsonrpc: 2, id: 1, method: "ping" }],
    [{ jsonrpc: "2.0", id: null, method: "ping" }],
    [{ jsonrpc: "2.0", id: 1.5, method: "ping" }],
    [{ jsonrpc: "2.0", id: true, method: "ping" }],
    [{ jsonrpc: "2.0", id: 1, method: {} }],
  ])("%j is not a request", (raw) => {
    expect(readMessage(raw)).toEqual({ kind: "invalid" });
  });
});

describe("versions", () => {
  test("a version it speaks is echoed; any other gets its newest", () => {
    for (const version of PROTOCOL_VERSIONS) expect(negotiateVersion(version)).toBe(version);
    for (const other of ["2030-01-01", "", undefined, 7, null]) {
      expect(negotiateVersion(other)).toBe(LATEST_PROTOCOL_VERSION);
    }
    expect([...PROTOCOL_VERSIONS].sort().reverse()).toEqual([...PROTOCOL_VERSIONS]);
  });
});

describe("answers", () => {
  test("a result and an error are JSON-RPC 2.0 objects", () => {
    expect(rpcResult(3, { ok: true })).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    expect(rpcError(null, -32600, "No.")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "No." },
    });
  });

  test("a tool's answer is its JSON as text and the same thing structured", () => {
    const text = JSON.stringify({ rows: [{ a: 1 }], truncated: false });
    expect(toolResult(text)).toEqual({
      content: [{ type: "text", text }],
      structuredContent: { rows: [{ a: 1 }], truncated: false },
      isError: false,
    });
  });

  test("a tool error is words for the model, marked as an error", () => {
    expect(toolError("That is not allowed.")).toEqual({
      content: [{ type: "text", text: "That is not allowed." }],
      isError: true,
    });
  });
});
