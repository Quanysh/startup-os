// Pure: one page of Linear's issues → board records.

import { CAPS, cleanRemote, isLinearUrl, type RecordOf } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const STATE_TYPES = ["backlog", "unstarted", "started", "completed"] as const;
type StateType = (typeof STATE_TYPES)[number];
const shape = () => new ConnectorError("Linear's issues were not in the expected shape.");

function parseIssue(node: unknown, viewerId: string): RecordOf<"issue"> | null {
  if (!isRecord(node) || !isRecord(node.state)) throw shape();
  const stateType = STATE_TYPES.find((type) => type === (node.state as Record<string, unknown>).type);
  // Triage, cancelled, or a type this build has never heard of: not on the board.
  if (stateType === undefined) return null;
  const updatedAt = typeof node.updatedAt === "string" ? Date.parse(node.updatedAt) : Number.NaN;
  if (typeof node.id !== "string" || node.id === "" || !Number.isFinite(updatedAt)) throw shape();
  const team = isRecord(node.team) ? node.team : {};
  const assignee = isRecord(node.assignee) ? node.assignee : null;
  const url = typeof node.url === "string" && isLinearUrl(node.url) ? node.url : "";
  const priority = Number.isInteger(node.priority) ? (node.priority as number) : 0;
  return {
    kind: "issue",
    issueId: node.id,
    identifier: cleanRemote(node.identifier, 40),
    title: cleanRemote(node.title, CAPS.title) || "(no title)",
    url,
    stateType: stateType as StateType,
    stateName: cleanRemote(node.state.name, CAPS.name),
    teamKey: cleanRemote(team.key, 20),
    teamName: cleanRemote(team.name, CAPS.name),
    assigneeName: assignee ? cleanRemote(assignee.name, CAPS.name) : "",
    mine: assignee !== null && assignee.id === viewerId,
    priority: priority >= 0 && priority <= 4 ? priority : 0,
    dueDate:
      typeof node.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(node.dueDate)
        ? node.dueDate
        : undefined,
    updatedAt,
  };
}

export function parseIssuePage(json: unknown): { rows: RecordOf<"issue">[]; next: string | null } {
  if (!isRecord(json)) throw shape();
  // Linear can answer 200 with an errors array. Its text is Linear's, so it is not kept.
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new ConnectorError("Linear reported an error for issues.");
  }
  const data = json.data;
  if (!isRecord(data) || !isRecord(data.viewer) || typeof data.viewer.id !== "string") throw shape();
  const issues = data.issues;
  if (!isRecord(issues) || !Array.isArray(issues.nodes) || !isRecord(issues.pageInfo)) throw shape();
  const viewerId = data.viewer.id;
  const rows = issues.nodes
    .map((node) => parseIssue(node, viewerId))
    .filter((row): row is RecordOf<"issue"> => row !== null);
  if (issues.pageInfo.hasNextPage !== true) return { rows, next: null };
  const cursor = issues.pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor === "") throw shape();
  return { rows, next: cursor };
}
