// Lazy data behind the card overlays: inclusive costs per cost root (one
// `agent_costs` read covers a root and all its sub-agents) and context use per
// on-screen session. Both read only while their overlay is on, for a bounded set.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { fetchAgentCosts, type AgentCosts } from "@/hooks/useAgentCosts";
import type { Conversation } from "@/hooks/useConversations";
import { authenticatedFetch } from "@/lib/identity";
import { getSessionSlim } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";
import {
  contextGauge,
  costRootsFor,
  hasActiveTurn,
  type ContextGauge,
} from "./projectGraphControls";
import type { ProjectGraphForest } from "./projectGraphForest";

/** At most this many trees read costs at once. */
export const MAX_COST_ROOTS = 24;
/** At most this many cards read their context use at once. */
export const MAX_CONTEXT_READS = 40;
const OVERLAY_STALE_MS = 30_000;
const COMPACTION_PAGE_LIMIT = 1000;
/** How often an on-screen working session's context gauge refreshes. */
export const WORKING_CONTEXT_POLL_MS = 15_000;

/** Inclusive costs for the trees of `ids`, keyed by cost root. Shares `useAgentCosts`'s cache. */
export function useProjectGraphCosts(
  forest: ProjectGraphForest,
  ids: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, AgentCosts | null> {
  const roots = useMemo(
    () =>
      enabled
        ? costRootsFor(forest, ids)
            .filter((id) => !isTempConvId(id))
            .slice(0, MAX_COST_ROOTS)
        : [],
    [enabled, forest, ids],
  );
  // Stable while the roots are, so the map only changes when a result does.
  const combine = useCallback(
    (results: { data?: AgentCosts | null }[]) => {
      const costs = new Map<string, AgentCosts | null>();
      roots.forEach((root, index) => {
        const data = results[index]?.data;
        if (data !== undefined) costs.set(root, data);
      });
      return costs;
    },
    [roots],
  );
  return useQueries({
    queries: roots.map((root) => ({
      // The same key `useAgentCosts` reads, so the chat and the graph share one copy.
      queryKey: ["agent_costs", root],
      queryFn: () => fetchAgentCosts(root),
      retry: false,
      staleTime: OVERLAY_STALE_MS,
    })),
    combine,
  });
}

/** Context gauges for on-screen sessions, from their slim snapshots; unknown ones are absent. */
export function useProjectGraphContext(
  rows: readonly Conversation[],
  enabled: boolean,
): ReadonlyMap<string, ContextGauge> {
  const targets = useMemo(
    () => (enabled ? rows.filter((row) => !isTempConvId(row.id)).slice(0, MAX_CONTEXT_READS) : []),
    [enabled, rows],
  );
  const combine = useCallback(
    (results: { data?: ContextGauge | null }[]) => {
      const gauges = new Map<string, ContextGauge>();
      targets.forEach((row, index) => {
        const gauge = results[index]?.data;
        if (gauge) gauges.set(row.id, gauge);
      });
      return gauges;
    },
    [targets],
  );
  return useQueries({
    queries: targets.map((row) => ({
      // A new turn moves `updated_at` and the token count with it.
      queryKey: ["project-graph-context", row.id, row.updated_at],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const session = await getSessionSlim(row.id, { signal });
        return contextGauge(session.lastTotalTokens, session.contextWindow);
      },
      retry: false,
      staleTime: OVERLAY_STALE_MS,
      // Sub-agent rows carry no timestamp to key on, so a working card re-reads its use.
      refetchInterval: hasActiveTurn(row) ? WORKING_CONTEXT_POLL_MS : (false as const),
    })),
    combine,
  });
}

/** How many times a session's context was compacted, read once its hover card opens. */
export function useCompactionCount(sessionId: string, updatedAt: number, enabled: boolean) {
  return useQuery({
    queryKey: ["project-graph-compactions", sessionId, updatedAt],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        type: "compaction",
        limit: String(COMPACTION_PAGE_LIMIT),
      });
      const res = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId)}/items?${params.toString()}`,
        { signal },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const page = (await res.json()) as { data?: unknown[]; has_more?: boolean };
      return { count: page.data?.length ?? 0, more: page.has_more === true };
    },
    enabled: enabled && !isTempConvId(sessionId),
    staleTime: 60_000,
    retry: false,
  });
}
