// Data behind the Project Memory panel and the Memory overlay: the chosen
// provider, whether it is on, which project key a graph project maps to, and
// the project's entries (one cached index both the panel and the cards read).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";
import { projectGraphStorageKey } from "../projectGraphStorage";
import { MAX_INDEX_ENTRIES } from "./memoryLogic";
import type { MemoryEntrySummary, MemoryProvider, MemoryStatus } from "./memoryProvider";
import {
  memoryProviderPreference,
  memoryProviders,
  resolveMemoryProvider,
  subscribeMemoryProviders,
} from "./memoryProviders";

const STATUS_STALE_MS = 60_000;
const INDEX_STALE_MS = 15_000;
/** Agents write while they work, so an index on screen re-reads on this interval. */
export const INDEX_POLL_MS = 30_000;
const INDEX_KEY = "project-graph-memory";

export interface MemoryIndex {
  entries: MemoryEntrySummary[];
  /** The project holds more entries than the index reads. */
  truncated: boolean;
}

/** Every installed provider and the one the viewer chose. */
export function useMemoryProvider(): {
  providers: readonly MemoryProvider[];
  provider: MemoryProvider;
  choose: (id: string) => void;
} {
  const providers = useSyncExternalStore(subscribeMemoryProviders, memoryProviders);
  const chosen = memoryProviderPreference.use();
  const choose = useCallback((id: string) => void memoryProviderPreference.write(id), []);
  return { providers, provider: resolveMemoryProvider(providers, chosen), choose };
}

/** Whether the provider is ready, off (with how to switch it on), or failing. */
export function useMemoryStatus(provider: MemoryProvider, enabled: boolean) {
  return useQuery<MemoryStatus>({
    queryKey: ["project-graph-memory-status", provider.id],
    queryFn: ({ signal }) => provider.status(signal),
    enabled,
    staleTime: STATUS_STALE_MS,
    retry: false,
  });
}

/** Project keys the provider already holds memories for; empty when it can't say. */
export function useKnownMemoryProjects(provider: MemoryProvider, enabled: boolean): string[] {
  const query = useQuery({
    queryKey: ["project-graph-memory-projects", provider.id],
    queryFn: ({ signal }) => provider.projects?.(signal) ?? Promise.resolve([]),
    enabled: enabled && provider.projects !== undefined,
    staleTime: STATUS_STALE_MS,
    retry: false,
  });
  return query.data ?? EMPTY;
}
const EMPTY: string[] = [];

/** Read a project's listing to its end, or to the index cap. */
export async function readMemoryIndex(
  provider: MemoryProvider,
  project: string,
  signal?: AbortSignal,
): Promise<MemoryIndex> {
  const seenTokens = new Set<string>();
  // Each page's token comes from the one before, so the pages are read in turn.
  const readFrom = async (
    token: string | null,
    before: readonly MemoryEntrySummary[],
  ): Promise<MemoryIndex> => {
    const page = await provider.list(project, token, signal);
    const entries = [...before, ...page.entries];
    const next = page.nextPageToken;
    if (next === null) return { entries, truncated: false };
    // A full index, an empty page or a repeated token all end the read early.
    if (entries.length >= MAX_INDEX_ENTRIES || page.entries.length === 0 || seenTokens.has(next))
      return { entries: entries.slice(0, MAX_INDEX_ENTRIES), truncated: true };
    seenTokens.add(next);
    return readFrom(next, entries);
  };
  return readFrom(null, []);
}

/** A project's entries, shared by the panel and the overlay and refreshed while shown. */
export function useMemoryIndex(provider: MemoryProvider, project: string | null, enabled: boolean) {
  return useQuery<MemoryIndex>({
    queryKey: [INDEX_KEY, provider.id, project],
    queryFn: ({ signal }) => readMemoryIndex(provider, project!, signal),
    enabled: enabled && project !== null && project !== "",
    staleTime: INDEX_STALE_MS,
    refetchInterval: INDEX_POLL_MS,
    retry: false,
  });
}

/** Re-read a provider's indexes and entries after a write or delete. */
export function useInvalidateMemory(provider: MemoryProvider): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [INDEX_KEY, provider.id] }),
      queryClient.invalidateQueries({ queryKey: ["project-graph-memory-entry", provider.id] }),
      queryClient.invalidateQueries({ queryKey: ["project-graph-memory-search", provider.id] }),
      queryClient.invalidateQueries({ queryKey: ["project-graph-memory-projects", provider.id] }),
    ]);
  }, [queryClient, provider.id]);
}

function projectKeyStorageKey(
  viewerId: string | null,
  projectName: string,
  providerId: string,
): string {
  return `${projectGraphStorageKey(viewerId, projectName)}:memory-project:${providerId}`;
}

function readStoredProjectKey(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey) || null;
  } catch {
    return null;
  }
}

/**
 * The project key the viewer picked for this graph project and provider, or
 * null while they haven't (the caller then uses its best guess).
 */
export function useStoredMemoryProject(
  viewerId: string | null,
  projectName: string,
  providerId: string,
): [string | null, (key: string | null) => void] {
  const storageKey = projectKeyStorageKey(viewerId, projectName, providerId);
  const [stored, setStored] = useState(() => ({
    storageKey,
    key: readStoredProjectKey(storageKey),
  }));
  let current = stored;
  if (stored.storageKey !== storageKey) {
    current = { storageKey, key: readStoredProjectKey(storageKey) };
    setStored(current);
  }
  const save = useCallback(
    (key: string | null) => {
      setStored({ storageKey, key });
      try {
        if (key === null) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, key);
      } catch {
        // Quota or disabled storage: the choice lasts for this visit only.
      }
    },
    [storageKey],
  );
  return [current.key, save];
}
