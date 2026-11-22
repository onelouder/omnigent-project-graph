// A project's sessions as a forest: top-level roots, sub-agents under their
// parent, nested family members under their representative, and fork links
// drawn as overlay edges. Pure TS: no React or xyflow at runtime.

import type { Conversation } from "@/hooks/useConversations";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { sessionFamilyGroups } from "@/lib/sessionFamilies";
import type { StatusBucket } from "@/shell/sidebarNav";

export const FORK_SOURCE_LABEL_KEY = "omnigent.fork.source_id";

export type ProjectGraphEdgeKind = "subagent" | "nested" | "fork";

export interface ProjectGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: ProjectGraphEdgeKind;
}

/** Counts over a node's descendants (the node itself excluded). */
export interface DescendantSummary {
  total: number;
  needsAttention: number;
  working: number;
}

export interface ProjectGraphForest {
  /** Rows by id, deduplicated. */
  nodesById: ReadonlyMap<string, Conversation>;
  /** Root ids, by their subtree's most urgent lane, then the root's own `updated_at`, newest first. */
  roots: readonly string[];
  /** Tree children (sub-agents and nested members), oldest first. */
  childrenById: ReadonlyMap<string, readonly string[]>;
  /** Each non-root's tree parent and the kind of edge to it. */
  parentById: ReadonlyMap<string, { id: string; kind: "subagent" | "nested" }>;
  /** Tree edges and fork overlay edges. */
  edges: readonly ProjectGraphEdge[];
  /** Forks whose source session isn't on the graph, by fork id: the source id. */
  externalForkSources: ReadonlyMap<string, string>;
  bucketById: ReadonlyMap<string, StatusBucket>;
  descendants: ReadonlyMap<string, DescendantSummary>;
}

export interface BuildForestOptions {
  /** Status lane of a row; the board's `columnOf`. */
  bucketOf: (row: Conversation) => StatusBucket;
  /** Keep archived rows; off by default. */
  includeArchived?: boolean;
}

/** Roots sort by their subtree's most urgent lane in this order. */
export const ROOT_BUCKET_ORDER: readonly StatusBucket[] = [
  "Needs attention",
  "Working",
  "Unread",
  "Draft",
  "Done",
];

/** The fork source a session was cloned from, from its provenance label. */
export function forkSourceId(row: Conversation): string | null {
  const source = row.labels?.[FORK_SOURCE_LABEL_KEY];
  return source && source !== row.id ? source : null;
}

/**
 * A sub-agent summary as a list row, so the graph renders it like any session.
 * Child summaries carry no timestamps; they read as 0 (unknown).
 */
export function childSessionRow(child: ChildSessionInfo, parentId: string): Conversation {
  const failed =
    !child.busy && (child.last_task_error != null || child.current_task_status === "failed");
  return {
    id: child.id,
    object: "conversation",
    title: child.task_summary || child.title || child.session_name || child.tool,
    created_at: 0,
    updated_at: 0,
    labels: child.labels ?? {},
    // Unknown until `withInheritedAccess` copies the parent's; 0 grants nothing.
    permission_level: NO_KNOWN_ACCESS,
    agent_name: child.tool,
    status: child.busy ? "running" : failed ? "failed" : "idle",
    pending_elicitations_count: child.pending_elicitations_count,
    parent_session_id: parentId,
  };
}

/** A child row's access before its parent's is known: no rights at all. */
export const NO_KNOWN_ACCESS = 0;

/**
 * Child rows with their parent's effective access: the viewer's permission
 * level and the owner. Runner and host stay unknown (child summaries carry
 * neither), never copied, since a sub-agent may run on its own runner. A child
 * whose parent isn't loaded keeps no access, so the graph offers no controls on it.
 *
 * :param parents: Rows the children hang from (list rows and other child rows).
 * :param children: Rows built by `childSessionRow`.
 */
export function withInheritedAccess(
  parents: readonly Conversation[],
  children: readonly Conversation[],
): Conversation[] {
  const byId = new Map<string, Conversation>(parents.map((row) => [row.id, row]));
  const childById = new Map(children.map((row) => [row.id, row]));
  const resolved = new Map<string, Conversation>();
  const resolve = (row: Conversation, seen: Set<string>): Conversation => {
    const done = resolved.get(row.id);
    if (done) return done;
    const parentId = row.parent_session_id;
    let parent = parentId ? byId.get(parentId) : undefined;
    if (!parent && parentId && !seen.has(parentId)) {
      const parentChild = childById.get(parentId);
      if (parentChild) parent = resolve(parentChild, new Set(seen).add(row.id));
    }
    const result: Conversation = parent
      ? {
          ...row,
          permission_level: parent.permission_level,
          owner: parent.owner,
        }
      : row;
    resolved.set(row.id, result);
    return result;
  };
  return children.map((row) => resolve(row, new Set([row.id])));
}

function wouldCycle(
  childId: string,
  parentId: string,
  parentOf: Map<string, { id: string; kind: "subagent" | "nested" }>,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = parentId;
  while (current !== undefined) {
    if (current === childId || seen.has(current)) return true;
    seen.add(current);
    current = parentOf.get(current)?.id;
  }
  return false;
}

/**
 * Build the forest from flat rows (project rows first, then child rows).
 *
 * :param rows: Project and sub-agent rows; duplicates keep their first copy.
 * :param options: How to file rows into status lanes, and whether archived rows stay.
 * :returns: Roots, tree children, typed edges and descendant counts.
 */
export function buildProjectGraphForest(
  rows: readonly Conversation[],
  options: BuildForestOptions,
): ProjectGraphForest {
  const nodesById = new Map<string, Conversation>();
  for (const row of rows) {
    if (nodesById.has(row.id)) continue;
    if (row.archived && !options.includeArchived) continue;
    nodesById.set(row.id, row);
  }
  const ordered = [...nodesById.values()];
  const parentOf = new Map<string, { id: string; kind: "subagent" | "nested" }>();

  // Sub-agents hang under their parent first; a family never overrides that.
  for (const row of ordered) {
    const parentId = row.parent_session_id;
    if (!parentId || !nodesById.has(parentId)) continue;
    if (wouldCycle(row.id, parentId, parentOf)) continue;
    parentOf.set(row.id, { id: parentId, kind: "subagent" });
  }
  for (const members of sessionFamilyGroups(ordered).values()) {
    const head = members[0];
    for (const member of members.slice(1)) {
      if (parentOf.has(member.id) || wouldCycle(member.id, head.id, parentOf)) continue;
      parentOf.set(member.id, { id: head.id, kind: "nested" });
    }
  }

  const childrenById = new Map<string, string[]>();
  for (const row of ordered) {
    const parent = parentOf.get(row.id);
    if (!parent) continue;
    const siblings = childrenById.get(parent.id) ?? [];
    siblings.push(row.id);
    childrenById.set(parent.id, siblings);
  }
  // Oldest first; untimed sub-agent rows keep their fetch order (stable sort).
  for (const siblings of childrenById.values()) {
    siblings.sort((a, b) => {
      const left = nodesById.get(a)!.created_at;
      const right = nodesById.get(b)!.created_at;
      return left === 0 || right === 0 ? 0 : left - right;
    });
  }

  const bucketById = new Map<string, StatusBucket>();
  for (const row of ordered) bucketById.set(row.id, options.bucketOf(row));

  const descendants = new Map<string, DescendantSummary>();
  const rank = new Map<string, number>();
  const summarize = (id: string, depth: number): DescendantSummary => {
    const known = descendants.get(id);
    if (known) return known;
    const summary: DescendantSummary = { total: 0, needsAttention: 0, working: 0 };
    let bestRank = ROOT_BUCKET_ORDER.indexOf(bucketById.get(id)!);
    // Parent links were cycle-checked, so depth is bounded by the row count.
    if (depth <= nodesById.size) {
      for (const childId of childrenById.get(id) ?? []) {
        const child = summarize(childId, depth + 1);
        const childBucket = bucketById.get(childId);
        summary.total += child.total + 1;
        summary.needsAttention +=
          child.needsAttention + (childBucket === "Needs attention" ? 1 : 0);
        summary.working += child.working + (childBucket === "Working" ? 1 : 0);
        bestRank = Math.min(bestRank, rank.get(childId)!);
      }
    }
    descendants.set(id, summary);
    rank.set(id, bestRank);
    return summary;
  };

  const roots = ordered.filter((row) => !parentOf.has(row.id)).map((row) => row.id);
  for (const id of roots) summarize(id, 0);
  // A root ranks by the most urgent lane anywhere in its subtree, so urgent
  // work under a calm root stays near the top; ties go to the root's own recency.
  const updatedAt = (id: string) => nodesById.get(id)!.updated_at;
  roots.sort(
    (a, b) => rank.get(a)! - rank.get(b)! || updatedAt(b) - updatedAt(a) || a.localeCompare(b),
  );

  const edges: ProjectGraphEdge[] = [];
  for (const row of ordered) {
    const parent = parentOf.get(row.id);
    if (parent) {
      edges.push({
        id: `${parent.kind}:${parent.id}->${row.id}`,
        source: parent.id,
        target: row.id,
        kind: parent.kind,
      });
    }
  }
  const externalForkSources = new Map<string, string>();
  for (const row of ordered) {
    const source = forkSourceId(row);
    if (source === null) continue;
    if (nodesById.has(source)) {
      edges.push({ id: `fork:${source}->${row.id}`, source, target: row.id, kind: "fork" });
    } else {
      externalForkSources.set(row.id, source);
    }
  }

  return {
    nodesById,
    roots,
    childrenById,
    parentById: parentOf,
    edges,
    externalForkSources,
    bucketById,
    descendants,
  };
}

/** The node and its ancestors, root last. */
export function ancestorPath(forest: ProjectGraphForest, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    path.push(current);
    seen.add(current);
    current = forest.parentById.get(current)?.id;
  }
  return path;
}

/** Every descendant of a node in tree order (the node itself excluded). */
export function subtreeIds(forest: ProjectGraphForest, id: string): string[] {
  const result: string[] = [];
  const stack = [...(forest.childrenById.get(id) ?? [])].reverse();
  const seen = new Set<string>([id]);
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    stack.push(...[...(forest.childrenById.get(next) ?? [])].reverse());
  }
  return result;
}
