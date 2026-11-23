// The memory providers this build offers. Omnigent's built-in memory is always
// first. A third-party system adds itself in either of two ways, neither of
// which edits this directory:
//
//   1. Drop a module at `web/src/projectGraphProviders/<name>/index.ts` whose
//      default export is a `MemoryProvider`. It is picked up at build time.
//   2. Call `registerMemoryProvider(provider)` from code that loads with the app.

import { createStoredPreference } from "@/lib/storedChoicePreference";
import { isMemoryProvider, type MemoryProvider } from "./memoryProvider";
import { omnigentMemoryProvider } from "./omnigentMemoryProvider";

/** Providers from modules, in path order; a module without a provider is skipped. */
export function providersFromModules(modules: Record<string, unknown>): MemoryProvider[] {
  const found: MemoryProvider[] = [];
  for (const path of Object.keys(modules).sort()) {
    const exported = (modules[path] as { default?: unknown } | null)?.default;
    if (isMemoryProvider(exported)) found.push(exported);
    else console.warn(`project-graph: ${path} has no default MemoryProvider export; skipped`);
  }
  return found;
}

/** `first`, then each of `rest` whose id isn't taken yet. */
export function mergeProviders(
  first: readonly MemoryProvider[],
  rest: readonly MemoryProvider[],
): MemoryProvider[] {
  const merged = [...first];
  for (const provider of rest) {
    if (!merged.some((known) => known.id === provider.id)) merged.push(provider);
  }
  return merged;
}

// An empty object when the directory doesn't exist, which is the usual case.
const discovered = providersFromModules(
  import.meta.glob("../../projectGraphProviders/*/index.{ts,tsx}", { eager: true }),
);

let providers: MemoryProvider[] = mergeProviders([omnigentMemoryProvider], discovered);
const listeners = new Set<() => void>();

/** Add a provider at runtime. One with an id already registered is ignored. */
export function registerMemoryProvider(provider: MemoryProvider): void {
  if (!isMemoryProvider(provider)) throw new Error("registerMemoryProvider: not a MemoryProvider");
  const next = mergeProviders(providers, [provider]);
  if (next.length === providers.length) return;
  providers = next;
  for (const listener of listeners) listener();
}

/** Every provider on offer, the built-in one first. The array is replaced, never mutated. */
export function memoryProviders(): readonly MemoryProvider[] {
  return providers;
}

export function subscribeMemoryProviders(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The viewer's chosen provider id; the built-in one until they pick another. */
export const memoryProviderPreference = createStoredPreference<string>(
  "omnigent:project-graph-memory-provider",
  (stored) => (stored ? stored : undefined),
  omnigentMemoryProvider.id,
);

/** The provider with `id`, or the built-in one when that provider isn't installed. */
export function resolveMemoryProvider(
  all: readonly MemoryProvider[],
  id: string | null | undefined,
): MemoryProvider {
  return all.find((provider) => provider.id === id) ?? all[0] ?? omnigentMemoryProvider;
}
