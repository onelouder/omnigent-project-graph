import { describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import {
  DEFAULT_AUTOMATION_PROJECT,
  SCHEDULED_TASK_LAUNCH_LABEL_KEY,
} from "@/lib/automationSessions";
import { PROJECT_LABEL_KEY } from "@/lib/sessionListCache";
import { projectBoardRows } from "@/projectHome/projectKanban";
import { projectGraphRows } from "./projectGraphRows";

const session = (id: string, fields: Partial<Conversation>) =>
  ({ id, created_at: 1, updated_at: 1, owner: "viewer", labels: {}, ...fields }) as Conversation;

const automation = { id: "automation", name: DEFAULT_AUTOMATION_PROJECT };
const projectRows = [
  session("first_class", { project_id: "automation" }),
  // A legacy member, filed by label with no project_id.
  session("legacy", { labels: { [PROJECT_LABEL_KEY]: DEFAULT_AUTOMATION_PROJECT } }),
  session("archived_member", { project_id: "automation", archived: true }),
];
const loadedRows = [
  session("shared_run", {
    owner: "teammate",
    labels: { [SCHEDULED_TASK_LAUNCH_LABEL_KEY]: "task" },
  }),
  session("shared_chat", { owner: "teammate" }),
];
const ids = (rows: Conversation[]) => rows.map((row) => row.id);

describe("projectGraphRows", () => {
  it("is exactly the board's row set, legacy members and shared runs included", () => {
    const board = projectBoardRows(projectRows, loadedRows, automation, "viewer");
    const graph = projectGraphRows(projectRows, loadedRows, [], automation, "viewer", false);
    expect(graph).toEqual(board);
    expect(ids(graph)).toEqual(["first_class", "legacy", "shared_run"]);
  });

  it("adds the project's archived members when the archived filter is on", () => {
    const archivedRows = [
      session("archived_member", { project_id: "automation", archived: true }),
      session("archived_elsewhere", { project_id: "other", archived: true }),
      session("first_class", { project_id: "automation" }),
    ];
    expect(
      ids(projectGraphRows(projectRows, loadedRows, archivedRows, automation, "viewer", true)),
    ).toEqual(["first_class", "legacy", "shared_run", "archived_member"]);
  });
});
