// The graph's rows: every page of the project's sessions (filtered as the board
// files them), plus sub-agents fetched for a few sessions up front and the rest on expand.

import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { childSessionsQueryKey, fetchChildSessions } from "@/hooks/useChildSessions";
import { useProjectSessions, useProjects, type Conversation } from "@/hooks/useConversations";
import { useOptionalLoadedConversations } from "@/hooks/useSidebarData";
import { useViewerId } from "@/hooks/useViewerId";
import { childSessionRow } from "./projectGraphForest";
import { projectGraphRows } from "./projectGraphRows";

const CHILD_POLL_MS = 30_000;

type ProjectSessionsQuery = ReturnType<typeof useProjectSessions>;

/** Follow `fetchNextPage` until the list is complete. */
function useAllPages(query: ProjectSessionsQuery, enabled: boolean) {
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [enabled, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
}

export interface ProjectGraphRows {
  rows: Conversation[];
  projectId: string | null;
  /** The live list, or the archived list while it's shown, hasn't answered yet. */
  isPending: boolean;
  isError: boolean;
  /** More list pages are still loading. */
  isPaging: boolean;
  /** Refetch every list the graph shows. */
  refetch: () => void;
}

export function useProjectGraphRows(
  projectName: string,
  includeArchived: boolean,
): ProjectGraphRows {
  const viewerId = useViewerId();
  const { data: projects } = useProjects();
  const projectId = projects?.find((project) => project.name === projectName)?.id ?? null;
  const live = useProjectSessions(projectName, true);
  const archived = useProjectSessions(projectName, includeArchived, "updated_at", true);
  useAllPages(live, true);
  useAllPages(archived, includeArchived);
  const loaded = useOptionalLoadedConversations();
  const rows = useMemo(
    () =>
      projectGraphRows(
        live.data?.pages.flatMap((page) => page.data) ?? [],
        loaded?.pages.flatMap((page) => page.data) ?? [],
        archived.data?.pages.flatMap((page) => page.data) ?? [],
        { id: projectId, name: projectName },
        viewerId,
        includeArchived,
      ),
    [live.data, archived.data, loaded, projectId, projectName, viewerId, includeArchived],
  );
  const { refetch: refetchLive } = live;
  const { refetch: refetchArchived } = archived;
  return {
    rows,
    projectId,
    isPending: live.isPending || (includeArchived && archived.isPending),
    isError: live.isError || (includeArchived && archived.isError),
    isPaging:
      live.hasNextPage ||
      live.isFetchingNextPage ||
      (includeArchived && (archived.hasNextPage || archived.isFetchingNextPage)),
    refetch: () => {
      void refetchLive();
      if (includeArchived) void refetchArchived();
    },
  };
}

export interface ProjectGraphChildren {
  childRows: Conversation[];
  /** Sessions whose sub-agents were fetched (or are being fetched). */
  requested: ReadonlySet<string>;
  /** Sessions whose sub-agent fetch hasn't answered yet. */
  loading: ReadonlySet<string>;
}

function useStableIds(ids: string[]): readonly string[] {
  const previous = useRef<readonly string[]>([]);
  const same =
    ids.length === previous.current.length &&
    ids.every((id, index) => id === previous.current[index]);
  if (!same) previous.current = ids;
  return previous.current;
}

/**
 * Sub-agents of `eagerIds` (a small, bounded set) and of every expanded
 * session the graph knows. Nothing else is fetched until it's expanded.
 * Shares `useChildSessions`' cache entries, so the Agents rail and the graph agree.
 *
 * :param shouldPoll: Whether a session's list keeps refreshing, e.g. only while
 *     it is visible and expanded. Read at each refetch decision.
 */
export function useProjectGraphChildren({
  eagerIds,
  expandedIds,
  listIds,
  shouldPoll,
}: {
  eagerIds: readonly string[];
  expandedIds: readonly string[];
  listIds: ReadonlySet<string>;
  shouldPoll: (sessionId: string) => boolean;
}): ProjectGraphChildren {
  // Sub-agent ids seen in fetched lists, so a saved expansion of one can load again.
  const [knownChildIds, setKnownChildIds] = useState<ReadonlySet<string>>(() => new Set());
  const ids = useStableIds([
    ...new Set([
      ...eagerIds,
      ...expandedIds.filter((id) => listIds.has(id) || knownChildIds.has(id)),
    ]),
  ]);
  const pollRef = useRef(shouldPoll);
  pollRef.current = shouldPoll;
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: childSessionsQueryKey(id),
      queryFn: () => fetchChildSessions(id),
      staleTime: 60_000,
      retry: false,
      refetchInterval: () => (pollRef.current(id) ? CHILD_POLL_MS : false),
    })),
  });
  const dataKey = results.map((result) => `${result.dataUpdatedAt}:${result.isPending}`).join(",");
  const { childRows, loading } = useMemo(() => {
    const rows: Conversation[] = [];
    const pending = new Set<string>();
    ids.forEach((id, index) => {
      const result = results[index];
      if (result?.isPending) pending.add(id);
      for (const child of result?.data ?? []) rows.push(childSessionRow(child, id));
    });
    return { childRows: rows, loading: pending };
    // `dataKey` stands in for the results array, which is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, dataKey]);
  useEffect(() => {
    setKnownChildIds((previous) =>
      childRows.every((row) => previous.has(row.id))
        ? previous
        : new Set([...previous, ...childRows.map((row) => row.id)]),
    );
  }, [childRows]);
  const requested = useMemo(() => new Set(ids), [ids]);
  return { childRows, requested, loading };
}
