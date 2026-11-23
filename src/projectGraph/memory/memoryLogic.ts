// Pure rules behind the Project Memory panel and the Memory overlay: project
// keys, the client-side filter, and the best-effort `[session:<id>]` tags that
// agents add to a memory's description.

import type { MemoryEntrySummary } from "./memoryProvider";

/** A tag an agent adds to a description: `[session:<its session id>]`. */
const SESSION_TAG = /\[session:\s*([A-Za-z0-9_-]{6,64})\s*\]/g;
/** Listings read for the index stop here; the panel says when it was cut short. */
export const MAX_INDEX_ENTRIES = 1_000;

/** What the Memory overlay counts, said wherever the counts or the snippet show. */
export const SESSION_TAG_NOTE =
  "Best-effort: a session counts only for memories whose description it tagged with its session id. Untagged writes aren’t counted.";

/** The instruction to paste into a project's or agent's instructions. */
export const SESSION_TAG_SNIPPET = [
  "When you save or update a project memory (memory_write under /projects/<repo>/),",
  "end its description with [session:<your session id>]. Your session id is the",
  "session_id that sys_session_get_info returns when called with no arguments.",
  "Keep the [session:...] tags already on a description you update, newest last,",
  "three at most. If you can't find your session id, leave the tag off.",
].join("\n");

/** Session ids compare without the `conv_` prefix some surfaces add. */
export function normalizeSessionId(id: string): string {
  return id.startsWith("conv_") ? id.slice("conv_".length) : id;
}

/** The session ids tagged on a description, normalized, in order, without repeats. */
export function parseSessionTags(description: string | null | undefined): string[] {
  if (!description) return [];
  const ids: string[] = [];
  for (const match of description.matchAll(SESSION_TAG)) {
    const id = normalizeSessionId(match[1]!);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A description as a person wrote it: without its session tags. */
export function stripSessionTags(description: string | null | undefined): string {
  if (!description) return "";
  return description.replace(SESSION_TAG, "").replace(/\s+/g, " ").trim();
}

/**
 * An edited description with the tags of the one it replaces put back, so an
 * edit in the panel doesn't erase which sessions wrote the memory. Tags are
 * dropped, oldest first, when they would push it past `maxLength`.
 */
export function withSessionTags(
  edited: string,
  previous: string | null | undefined,
  maxLength = Number.POSITIVE_INFINITY,
): string | null {
  const text = stripSessionTags(edited);
  let tags = previous ? [...previous.matchAll(SESSION_TAG)].map((match) => match[0]) : [];
  const join = () => [text, ...tags].filter(Boolean).join(" ");
  while (tags.length > 0 && join().length > maxLength) tags = tags.slice(1);
  return join() || null;
}

/** How many of a project's memories each session is tagged on. */
export function memoryCountsBySession(
  entries: readonly MemoryEntrySummary[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const id of parseSessionTags(entry.description)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The sessions on a branch that wrote to memory: each tagged session on the
 * graph plus its ancestors, so the path from a root down to a writer can be
 * highlighted. `parentOf` returns a session's tree parent, or null for a root.
 */
export function memoryBranchIds(
  writers: Iterable<string>,
  parentOf: (id: string) => string | null,
): ReadonlySet<string> {
  const branch = new Set<string>();
  for (const writer of writers) {
    let id: string | null = writer;
    // Stopping at a session already on the branch also ends a walk through cyclic links.
    while (id !== null && !branch.has(id)) {
      branch.add(id);
      id = parentOf(id);
    }
  }
  return branch;
}

/** Entries whose name or description contains every word of `query`. */
export function filterEntries<T extends MemoryEntrySummary>(
  entries: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = `${entry.name}\n${entry.description ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The last segment of a session's workspace path, e.g. "/src/api/" → "api". */
export function workspaceName(workspace: string | null | undefined): string | null {
  if (!workspace) return null;
  const segments = workspace.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? null;
}

/**
 * Project keys to offer for a graph project, likeliest first.
 *
 * Agents file project memories under their repository's name, which the graph
 * can't see. It guesses from the sessions' workspace directory names (most
 * common first), then the project's own name; keys the provider already holds
 * memories for come first among those, and the rest of the known keys follow.
 */
export function projectKeyCandidates(
  projectName: string,
  workspaces: readonly (string | null | undefined)[],
  knownKeys: readonly string[],
): string[] {
  const tally = new Map<string, number>();
  for (const workspace of workspaces) {
    const name = workspaceName(workspace);
    if (name) tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  const guesses = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const trimmed = projectName.trim();
  if (trimmed) guesses.push(trimmed);
  const known = new Set(knownKeys);
  const ordered = [
    ...guesses.filter((key) => known.has(key)),
    ...guesses.filter((key) => !known.has(key)),
    ...[...knownKeys].sort((a, b) => a.localeCompare(b)),
  ];
  return [...new Set(ordered)];
}

/** A date for a listing row, e.g. "2026-11-22"; empty when unknown. */
export function formatMemoryDate(updatedAt: number | null): string {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return "";
  return new Date(updatedAt * 1000).toISOString().slice(0, 10);
}

/** UTF-8 byte length, the unit memory content limits use. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
