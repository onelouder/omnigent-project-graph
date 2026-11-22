// The graph's list rows: exactly the board's rows, plus archived members when
// the archived filter is on.

import type { Conversation } from "@/hooks/useConversations";
import { projectBoardRows } from "@/projectHome/projectKanban";
import { dedupeConversationsById, sessionInSidebarFolder } from "@/shell/sidebarNav";

/**
 * :param projectRows: Every loaded page of the project's unarchived list.
 * :param loadedRows: The sidebar's loaded rows, for shared automation runs.
 * :param archivedRows: The project's archived list; ignored unless `includeArchived`.
 * :returns: `projectBoardRows()` unchanged, then archived members the board would file here.
 */
export function projectGraphRows(
  projectRows: readonly Conversation[],
  loadedRows: readonly Conversation[],
  archivedRows: readonly Conversation[],
  project: { id: string | null; name: string },
  viewerId: string | null,
  includeArchived: boolean,
): Conversation[] {
  const board = projectBoardRows(projectRows, loadedRows, project, viewerId);
  if (!includeArchived) return board;
  const archived = archivedRows.filter(
    (row) => row.archived && sessionInSidebarFolder(row, project, viewerId, true),
  );
  return dedupeConversationsById([...board, ...archived]);
}
