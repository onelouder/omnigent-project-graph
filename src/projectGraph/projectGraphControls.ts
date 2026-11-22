// Pure helpers for the graph's control plane: who may act on a session, which
// sessions a stop sends to, the context gauge's tone, and costs that
// never count a sub-agent twice. No React or xyflow.

import type { AgentCost, AgentCosts } from "@/hooks/useAgentCosts";
import type { Conversation } from "@/hooks/useConversations";
import { LEVEL_EDIT } from "@/lib/permissionsApi";
import { SIDE_CHAT_LABEL_KEY } from "@/lib/sessionListCache";
import { isSessionStoppable } from "@/lib/sessionStop";
import { isOwnedByViewer } from "@/shell/sidebarNav";
import { ancestorPath, subtreeIds, type ProjectGraphForest } from "./projectGraphForest";
import { isWaitingOnUser } from "./projectGraphStatus";

/**
 * Whether the viewer may approve, stop or message a session: an edit grant or
 * better, or, when the server sends no level, owning it. Unknown access isn't editable.
 */
export function canControlSession(row: Conversation, viewerId: string | null): boolean {
  const level = row.permission_level;
  if (level != null) return level >= LEVEL_EDIT;
  return isOwnedByViewer(row, viewerId);
}

/** Whether a session has a turn in flight that "Cancel turn" can interrupt. */
export function hasActiveTurn(row: Conversation): boolean {
  return row.status === "running" && row.archived !== true;
}

/**
 * Whether "Stop session" applies, the one rule for the card menu, bulk and
 * subtree stops: an unarchived session the viewer controls, backed by a host
 * runner or a stoppable wrapper, or a sub-agent (the server finds its runner).
 * A runner that looks offline doesn't block it: the server settles orphaned
 * "running" sessions on stop, and stopping an idle one is a no-op.
 */
export function canStopSession(row: Conversation, viewerId: string | null): boolean {
  return (
    row.archived !== true &&
    canControlSession(row, viewerId) &&
    (Boolean(row.parent_session_id) ||
      isSessionStoppable({ labels: row.labels, hostId: row.host_id, runnerId: row.runner_id }))
  );
}

/** A top-level session that isn't a side chat riding another session's runner. */
function isTopLevel(row: Conversation): boolean {
  return !row.parent_session_id && !row.labels?.[SIDE_CHAT_LABEL_KEY];
}

/**
 * A kept target whose stop provably reaches `id` as well: a top-level
 * ancestor on the same runner the server reported for both. A runner that
 * isn't known for either never counts, so such a session gets its own stop.
 */
function coveringTarget(
  forest: ProjectGraphForest,
  id: string,
  kept: ReadonlySet<string>,
): string | null {
  const runner = forest.nodesById.get(id)?.runner_id;
  if (!runner) return null;
  for (const ancestorId of ancestorPath(forest, id).slice(1)) {
    const ancestor = forest.nodesById.get(ancestorId);
    if (ancestor && kept.has(ancestorId) && isTopLevel(ancestor) && ancestor.runner_id === runner)
      return ancestorId;
  }
  return null;
}

/** What a bulk or subtree stop sends, split so running orchestrators need their own consent. */
export interface StopPlan {
  /** Sessions to stop, each sent its own `stop_session` unless provably redundant. */
  targets: string[];
  /**
   * Picked top-level sessions that are working with sessions under them.
   * Left out of `targets` unless the viewer opts in separately.
   */
  orchestrators: string[];
}

/** Whether a session is a working orchestrator: a working top-level session with sessions under it. */
export function isRunningOrchestrator(forest: ProjectGraphForest, id: string): boolean {
  const row = forest.nodesById.get(id);
  if (!row || !isTopLevel(row) || !hasActiveTurn(row)) return false;
  return (forest.childrenById.get(id)?.length ?? 0) > 0;
}

/**
 * Plan a stop over picked sessions: keep those the viewer may stop, set
 * running orchestrators aside, and drop only a session a kept top-level
 * ancestor on the same known runner already stops. Never adds an unpicked
 * session, so no ancestor is stopped.
 */
export function planStop(
  forest: ProjectGraphForest,
  picks: Iterable<string>,
  viewerId: string | null,
): StopPlan {
  // Shallowest first, so an ancestor is kept before the sessions under it.
  const stoppable = [...new Set(picks)]
    .filter((id) => {
      const row = forest.nodesById.get(id);
      return row !== undefined && canStopSession(row, viewerId);
    })
    .map((id, index) => ({ id, index, depth: ancestorPath(forest, id).length }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ id }) => id);
  const orchestrators = stoppable.filter((id) => isRunningOrchestrator(forest, id));
  const kept = new Set<string>();
  const targets: string[] = [];
  for (const id of stoppable) {
    if (orchestrators.includes(id) || coveringTarget(forest, id, kept) !== null) continue;
    kept.add(id);
    targets.push(id);
  }
  return { targets, orchestrators };
}

/** A subtree stop's picks: the node and its loaded descendants, in tree order. */
export function subtreeStopPicks(forest: ProjectGraphForest, id: string): string[] {
  return forest.nodesById.has(id) ? [id, ...subtreeIds(forest, id)] : [];
}

/** Sessions waiting on the viewer that the viewer may answer, in the given (tree) order. */
export function awaitingSessionIds(
  forest: ProjectGraphForest,
  order: readonly string[],
  viewerId: string | null,
): string[] {
  return order.filter((id) => {
    const row = forest.nodesById.get(id);
    return row !== undefined && isWaitingOnUser(row) && canControlSession(row, viewerId);
  });
}

// --- Context gauge ---

export const CONTEXT_WARNING_RATIO = 0.8;
export const CONTEXT_DANGER_RATIO = 0.95;

export type ContextGaugeTone = "normal" | "warning" | "destructive";

export interface ContextGauge {
  /** Used share of the window, clamped to 0..1. */
  ratio: number;
  tone: ContextGaugeTone;
  usedTokens: number;
  windowTokens: number;
}

/** The card's context gauge, or null when either number is unknown. */
export function contextGauge(
  lastTotalTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): ContextGauge | null {
  if (typeof lastTotalTokens !== "number" || !Number.isFinite(lastTotalTokens)) return null;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return null;
  const raw = Math.max(0, lastTotalTokens) / contextWindow;
  const tone: ContextGaugeTone =
    raw > CONTEXT_DANGER_RATIO ? "destructive" : raw > CONTEXT_WARNING_RATIO ? "warning" : "normal";
  return {
    ratio: Math.min(1, raw),
    tone,
    usedTokens: Math.max(0, lastTotalTokens),
    windowTokens: contextWindow,
  };
}

// --- Cost ---

/**
 * The top-level session whose `agent_costs` list carries this session's cost:
 * the session itself, or the ancestor its sub-agent chain started from.
 */
export function costRootOf(forest: ProjectGraphForest, id: string): string | null {
  const seen = new Set<string>();
  let current = forest.nodesById.get(id);
  while (current?.parent_session_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = forest.nodesById.get(current.parent_session_id);
    // A sub-agent whose parent isn't loaded can't be priced from its tree.
    if (!parent) return null;
    current = parent;
  }
  return current?.id ?? null;
}

/** Each distinct cost root for these sessions, in first-seen order. */
export function costRootsFor(forest: ProjectGraphForest, ids: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const id of ids) {
    const root = costRootOf(forest, id);
    if (root !== null) roots.add(root);
  }
  return [...roots];
}

/**
 * A card's cost: the inclusive total `agent_costs` reports for it (its own
 * spend plus its sub-agents'). Shown as is, never added to its children's.
 */
export function cardCost(
  forest: ProjectGraphForest,
  id: string,
  costsByRoot: ReadonlyMap<string, AgentCosts | null>,
): AgentCost | null {
  const root = costRootOf(forest, id);
  if (root === null) return null;
  const cost = costsByRoot.get(root)?.get(id);
  return typeof cost?.costUsd === "number" ? cost : null;
}

export interface CostTotal {
  costUsd: number;
  /** Some part is a parent-reported estimate. */
  estimated: boolean;
  /** Cost roots that reported a cost. */
  priced: number;
}

/**
 * The spend across these sessions without counting any twice: only each cost
 * root's inclusive total is summed, since it already includes its sub-agents.
 */
export function totalCost(
  forest: ProjectGraphForest,
  ids: Iterable<string>,
  costsByRoot: ReadonlyMap<string, AgentCosts | null>,
): CostTotal | null {
  let costUsd = 0;
  let estimated = false;
  let priced = 0;
  for (const root of costRootsFor(forest, ids)) {
    const cost = costsByRoot.get(root)?.get(root);
    if (typeof cost?.costUsd !== "number") continue;
    costUsd += cost.costUsd;
    estimated ||= cost.estimated;
    priced++;
  }
  return priced > 0 ? { costUsd, estimated, priced } : null;
}
