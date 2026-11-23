import { describe, expect, it, vi } from "vitest";
import { MAX_INDEX_ENTRIES } from "./memoryLogic";
import type { MemoryEntrySummary, MemoryPage, MemoryProvider } from "./memoryProvider";
import { readMemoryIndex } from "./useProjectMemory";

const entries = (count: number, from = 0): MemoryEntrySummary[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `e${from + index}`,
    name: `e${from + index}`,
    description: null,
    updatedAt: null,
  }));

const providerOf = (list: MemoryProvider["list"]): MemoryProvider => ({
  id: "fake",
  label: "Fake",
  sessionTags: true,
  status: async () => ({ state: "ready", search: false }),
  list,
  get: async () => null,
});

describe("readMemoryIndex", () => {
  it("follows page tokens to the end", async () => {
    const pages: Record<string, MemoryPage> = {
      start: { entries: entries(2), nextPageToken: "p2" },
      p2: { entries: entries(1, 2), nextPageToken: null },
    };
    const list = vi.fn(async (_project: string, token: string | null) => pages[token ?? "start"]!);
    const index = await readMemoryIndex(providerOf(list), "demo");
    expect(index.entries.map((entry) => entry.id)).toEqual(["e0", "e1", "e2"]);
    expect(index.truncated).toBe(false);
    expect(list.mock.calls.map((call) => call[1])).toEqual([null, "p2"]);
  });

  it("stops at the cap and says the index is cut short", async () => {
    let served = 0;
    const list = vi.fn(async () => {
      const page = { entries: entries(400, served), nextPageToken: `after-${served}` };
      served += 400;
      return page;
    });
    const index = await readMemoryIndex(providerOf(list), "demo");
    expect(index.entries).toHaveLength(MAX_INDEX_ENTRIES);
    expect(index.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("stops when a provider repeats a token or sends an empty page", async () => {
    const repeating = vi.fn(async () => ({ entries: entries(1), nextPageToken: "same" }));
    expect((await readMemoryIndex(providerOf(repeating), "demo")).truncated).toBe(true);
    expect(repeating).toHaveBeenCalledTimes(2);
    const empty = vi.fn(async () => ({ entries: [], nextPageToken: "more" }));
    await readMemoryIndex(providerOf(empty), "demo");
    expect(empty).toHaveBeenCalledTimes(1);
  });
});
