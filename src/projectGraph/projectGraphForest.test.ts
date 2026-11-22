import { describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import type { StatusBucket } from "@/shell/sidebarNav";
import {
  ancestorPath,
  buildProjectGraphForest,
  childSessionRow,
  FORK_SOURCE_LABEL_KEY,
  subtreeIds,
} from "./projectGraphForest";

function row(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 1,
    updated_at: 1,
    labels: {},
    permission_level: null,
    ...overrides,
  };
}

const allDone = () => "Done" as StatusBucket;

describe("buildProjectGraphForest", () => {
  it("hangs sub-agents under their parent by parent_session_id", () => {
    const forest = buildProjectGraphForest(
      [row("root"), row("child", { parent_session_id: "root" })],
      { bucketOf: allDone },
    );
    expect(forest.roots).toEqual(["root"]);
    expect(forest.childrenById.get("root")).toEqual(["child"]);
    expect(forest.edges).toEqual([
      { id: "subagent:root->child", source: "root", target: "child", kind: "subagent" },
    ]);
  });

  it("draws a family's representative as the parent of its nested members", () => {
    const family = { id: "fam", representative_id: "head", pinned: false };
    const forest = buildProjectGraphForest(
      [
        row("nested_b", { family, created_at: 3 }),
        row("head", { family, created_at: 1 }),
        row("nested_a", { family, created_at: 2 }),
      ],
      { bucketOf: allDone },
    );
    expect(forest.roots).toEqual(["head"]);
    expect(forest.childrenById.get("head")).toEqual(["nested_a", "nested_b"]);
    expect(forest.edges.map((edge) => edge.kind)).toEqual(["nested", "nested"]);
  });

  it("links a labelled fork with an overlay edge and keeps it a root", () => {
    const forest = buildProjectGraphForest(
      [
        row("source"),
        row("fork", { labels: { [FORK_SOURCE_LABEL_KEY]: "source" } }),
        row("outside_fork", { labels: { [FORK_SOURCE_LABEL_KEY]: "elsewhere" } }),
      ],
      { bucketOf: allDone },
    );
    expect([...forest.roots].sort()).toEqual(["fork", "outside_fork", "source"]);
    expect(forest.childrenById.size).toBe(0);
    expect(forest.edges).toEqual([
      { id: "fork:source->fork", source: "source", target: "fork", kind: "fork" },
    ]);
    expect(forest.externalForkSources.get("outside_fork")).toBe("elsewhere");
  });

  it("promotes a row whose parent isn't loaded to a root", () => {
    const forest = buildProjectGraphForest([row("orphan", { parent_session_id: "missing" })], {
      bucketOf: allDone,
    });
    expect(forest.roots).toEqual(["orphan"]);
    expect(forest.edges).toEqual([]);
  });

  it("breaks parent cycles instead of looping", () => {
    const forest = buildProjectGraphForest(
      [
        row("a", { parent_session_id: "c" }),
        row("b", { parent_session_id: "a" }),
        row("c", { parent_session_id: "b" }),
      ],
      { bucketOf: allDone },
    );
    expect(forest.roots).toHaveLength(1);
    const [root] = forest.roots;
    expect(subtreeIds(forest, root)).toHaveLength(2);
    expect(ancestorPath(forest, "a").at(-1)).toBe(root);
  });

  it("keeps the first copy of duplicate rows and drops archived rows unless asked", () => {
    const rows = [
      row("a", { title: "first" }),
      row("a", { title: "second" }),
      row("old", { archived: true }),
    ];
    const forest = buildProjectGraphForest(rows, { bucketOf: allDone });
    expect(forest.nodesById.get("a")?.title).toBe("first");
    expect(forest.nodesById.has("old")).toBe(false);
    expect(
      buildProjectGraphForest(rows, { bucketOf: allDone, includeArchived: true }).nodesById.has(
        "old",
      ),
    ).toBe(true);
  });

  it("ranks a root by the most urgent lane in its subtree", () => {
    const bucket: Record<string, StatusBucket> = {
      working_root: "Working",
      done_root: "Done",
      urgent_child: "Needs attention",
    };
    const forest = buildProjectGraphForest(
      [
        row("working_root", { updated_at: 50 }),
        row("done_root", { updated_at: 1 }),
        row("urgent_child", { parent_session_id: "done_root", updated_at: 2 }),
      ],
      { bucketOf: (conversation) => bucket[conversation.id] },
    );
    // A Done root with an urgent child sorts ahead of a Working root with none.
    expect(forest.roots).toEqual(["done_root", "working_root"]);
  });

  it("orders roots by lane, then by the root's own updated_at, newest first", () => {
    const bucket: Record<string, StatusBucket> = {
      done_new: "Done",
      done_old: "Done",
      fresh_child: "Done",
      unread: "Unread",
      working: "Working",
    };
    const forest = buildProjectGraphForest(
      [
        row("done_old", { updated_at: 10 }),
        // A newer descendant doesn't lift its older root.
        row("fresh_child", { parent_session_id: "done_old", updated_at: 99 }),
        row("done_new", { updated_at: 20 }),
        row("unread", { updated_at: 5 }),
        row("working", { updated_at: 1 }),
      ],
      { bucketOf: (conversation) => bucket[conversation.id] },
    );
    expect(forest.roots).toEqual(["working", "unread", "done_new", "done_old"]);
  });

  it("counts descendants with their urgent and working members", () => {
    const bucket: Record<string, StatusBucket> = {
      root: "Done",
      a: "Working",
      b: "Needs attention",
      c: "Done",
    };
    const forest = buildProjectGraphForest(
      [
        row("root"),
        row("a", { parent_session_id: "root" }),
        row("b", { parent_session_id: "a" }),
        row("c", { parent_session_id: "root" }),
      ],
      { bucketOf: (conversation) => bucket[conversation.id] },
    );
    expect(forest.descendants.get("root")).toEqual({ total: 3, needsAttention: 1, working: 1 });
    expect(forest.descendants.get("a")).toEqual({ total: 1, needsAttention: 1, working: 0 });
    expect(forest.descendants.get("c")).toEqual({ total: 0, needsAttention: 0, working: 0 });
  });

  it("turns a child-session summary into a row under its parent", () => {
    const child = childSessionRow(
      {
        id: "sub",
        title: "researcher:auth",
        task_summary: "Investigate auth",
        tool: "researcher",
        session_name: "auth",
        current_task_status: "completed",
        busy: true,
        last_message_preview: null,
        pending_elicitations_count: 1,
      },
      "root",
    );
    expect(child).toMatchObject({
      id: "sub",
      title: "Investigate auth",
      status: "running",
      pending_elicitations_count: 1,
      parent_session_id: "root",
    });
  });
});
