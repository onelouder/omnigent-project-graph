import { describe, expect, it, vi } from "vitest";
import { isMemoryProvider, type MemoryProvider } from "./memoryProvider";
import {
  memoryProviders,
  mergeProviders,
  providersFromModules,
  registerMemoryProvider,
  resolveMemoryProvider,
  subscribeMemoryProviders,
} from "./memoryProviders";

const fake = (id: string): MemoryProvider => ({
  id,
  label: `Provider ${id}`,
  sessionTags: false,
  status: async () => ({ state: "ready", search: false }),
  list: async () => ({ entries: [], nextPageToken: null }),
  get: async () => null,
});

describe("memory providers", () => {
  it("offers Omnigent's built-in memory first, and alone by default", () => {
    expect(memoryProviders().map((provider) => provider.id)).toEqual(["omnigent"]);
  });

  it("takes providers from add-on modules in path order, skipping anything else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const found = providersFromModules({
      "../../projectGraphProviders/zeta/index.ts": { default: fake("zeta") },
      "../../projectGraphProviders/alpha/index.ts": { default: fake("alpha") },
      "../../projectGraphProviders/broken/index.ts": { default: { id: "broken" } },
      "../../projectGraphProviders/empty/index.ts": {},
    });
    expect(found.map((provider) => provider.id)).toEqual(["alpha", "zeta"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("keeps the first provider registered under an id", () => {
    const first = fake("same");
    expect(mergeProviders([first], [fake("same"), fake("other")])).toEqual([
      first,
      expect.objectContaining({ id: "other" }),
    ]);
  });

  it("falls back to the built-in provider when the chosen one isn't installed", () => {
    const all = [fake("omnigent"), fake("extra")];
    expect(resolveMemoryProvider(all, "extra").id).toBe("extra");
    expect(resolveMemoryProvider(all, "removed").id).toBe("omnigent");
    expect(resolveMemoryProvider(all, null).id).toBe("omnigent");
  });

  it("registers a provider at runtime and tells subscribers once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMemoryProviders(listener);
    const before = memoryProviders();
    registerMemoryProvider(fake("runtime"));
    registerMemoryProvider(fake("runtime"));
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(memoryProviders().map((provider) => provider.id)).toEqual(["omnigent", "runtime"]);
    // Replaced, not mutated, so React sees the change.
    expect(memoryProviders()).not.toBe(before);
    expect(() => registerMemoryProvider({ id: "bad" } as MemoryProvider)).toThrow();
  });

  it("recognizes the minimum a provider must implement", () => {
    expect(isMemoryProvider(fake("ok"))).toBe(true);
    expect(isMemoryProvider({ ...fake("ok"), id: "" })).toBe(false);
    expect(isMemoryProvider({ ...fake("ok"), list: undefined })).toBe(false);
    expect(isMemoryProvider(null)).toBe(false);
  });
});
