import { describe, expect, it } from "vitest";
import {
  filterEntries,
  formatMemoryDate,
  memoryBranchIds,
  memoryCountsBySession,
  normalizeSessionId,
  parseSessionTags,
  projectKeyCandidates,
  stripSessionTags,
  withSessionTags,
  workspaceName,
} from "./memoryLogic";
import type { MemoryEntrySummary } from "./memoryProvider";

const entry = (name: string, description: string | null = null): MemoryEntrySummary => ({
  id: `/projects/demo/${name}`,
  name,
  description,
  updatedAt: 1_795_000_000,
});

describe("session tags", () => {
  it("reads every tag once, without the conv_ prefix", () => {
    expect(
      parseSessionTags("Deploy rules [session:abc123] [session: conv_def456 ] [session:abc123]"),
    ).toEqual(["abc123", "def456"]);
    expect(normalizeSessionId("conv_abc123")).toBe("abc123");
  });

  it("ignores text that only looks like a tag", () => {
    expect(parseSessionTags(null)).toEqual([]);
    expect(parseSessionTags("see [session] and [session:x] and session:abcdef")).toEqual([]);
    expect(parseSessionTags("[session:has spaces inside]")).toEqual([]);
  });

  it("strips tags from what a person reads", () => {
    expect(stripSessionTags("Deploy rules [session:abc123]")).toBe("Deploy rules");
    expect(stripSessionTags("[session:abc123]")).toBe("");
    expect(stripSessionTags(undefined)).toBe("");
  });

  it("puts the previous tags back on an edited description", () => {
    expect(withSessionTags("New text", "Old [session:abc123] [session:def456]")).toBe(
      "New text [session:abc123] [session:def456]",
    );
    expect(withSessionTags("  ", null)).toBeNull();
    expect(withSessionTags("", "Old [session:abc123]")).toBe("[session:abc123]");
  });

  it("drops the oldest tags rather than exceed the description limit", () => {
    const previous = "Old [session:aaaaaa] [session:bbbbbb]";
    expect(withSessionTags("New text", previous, 25)).toBe("New text [session:bbbbbb]");
    expect(withSessionTags("New text", previous, 10)).toBe("New text");
  });

  it("counts each session once per memory it tagged", () => {
    const counts = memoryCountsBySession([
      entry("a", "x [session:abc123]"),
      entry("b", "y [session:abc123] [session:conv_def456]"),
      entry("c", "untagged"),
      entry("d"),
    ]);
    expect([...counts]).toEqual([
      ["abc123", 2],
      ["def456", 1],
    ]);
  });

  it("marks each writer and its ancestors as a memory branch", () => {
    const parents: Record<string, string | null> = {
      root: null,
      mid: "root",
      leaf: "mid",
      sibling: "root",
      loner: null,
    };
    const branch = memoryBranchIds(["leaf", "loner"], (id) => parents[id] ?? null);
    expect([...branch].sort()).toEqual(["leaf", "loner", "mid", "root"]);
  });

  it("ends on cyclic parent links", () => {
    const parents: Record<string, string> = { a: "b", b: "a" };
    expect([...memoryBranchIds(["a"], (id) => parents[id] ?? null)].sort()).toEqual(["a", "b"]);
  });
});

describe("filterEntries", () => {
  const entries = [entry("deploy/gotchas", "Things that broke"), entry("testing", "How CI runs")];

  it("matches every word against names and descriptions, ignoring case", () => {
    expect(filterEntries(entries, "DEPLOY broke").map((item) => item.name)).toEqual([
      "deploy/gotchas",
    ]);
    expect(filterEntries(entries, "ci").map((item) => item.name)).toEqual(["testing"]);
    expect(filterEntries(entries, "deploy ci")).toEqual([]);
  });

  it("returns everything for a blank query", () => {
    expect(filterEntries(entries, "   ")).toHaveLength(2);
  });
});

describe("projectKeyCandidates", () => {
  it("prefers the commonest workspace name the provider already holds memories for", () => {
    expect(
      projectKeyCandidates(
        "My Project",
        ["/src/api", "/src/api/", "/wt/feature-x", null, undefined],
        ["feature-x", "zeta", "alpha"],
      ),
    ).toEqual(["feature-x", "api", "My Project", "alpha", "zeta"]);
  });

  it("falls back to the workspace name, then the project's own name", () => {
    expect(projectKeyCandidates("demo", ["C:\\\\work\\\\api"], [])).toEqual(["api", "demo"]);
    expect(projectKeyCandidates("demo", [], [])).toEqual(["demo"]);
    expect(projectKeyCandidates("  ", [], [])).toEqual([]);
  });

  it("names a workspace by its last directory", () => {
    expect(workspaceName("/home/me/projects/api/")).toBe("api");
    expect(workspaceName("")).toBeNull();
  });
});

describe("formatMemoryDate", () => {
  it("shows a UTC date, and nothing when the time is unknown", () => {
    expect(formatMemoryDate(1_795_000_000)).toBe("2026-11-18");
    expect(formatMemoryDate(null)).toBe("");
  });
});
