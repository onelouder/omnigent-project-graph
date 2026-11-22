import { describe, expect, it } from "vitest";
import type { AgentCosts } from "@/hooks/useAgentCosts";
import type { Conversation } from "@/hooks/useConversations";
import {
  awaitingSessionIds,
  canControlSession,
  canStopSession,
  cardCost,
  contextGauge,
  costRootOf,
  hasActiveTurn,
  planStop,
  subtreeStopPicks,
  totalCost,
} from "./projectGraphControls";
import {
  buildProjectGraphForest,
  childSessionRow,
  NO_KNOWN_ACCESS,
  withInheritedAccess,
} from "./projectGraphForest";

const VIEWER = "user_me";

// A host-backed session the viewer owns, on its own runner unless told otherwise.
function row(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 1,
    updated_at: 1,
    labels: {},
    permission_level: null,
    host_id: "host_1",
    runner_id: `runner_${id}`,
    owner: VIEWER,
    ...overrides,
  };
}

const forestOf = (rows: Conversation[]) =>
  buildProjectGraphForest(rows, { bucketOf: () => "Done", includeArchived: true });

// root ─┬─ sub1 ── sub1a   (both on root's runner)
//       ├─ sub2            (archived)
//       ├─ sub3            (its own runner)
//       └─ sub4            (runner unknown)
// other (view-only) ── otherSub
// rep ┄ member (nested family: its own runner)
const rows = [
  row("root"),
  row("sub1", { parent_session_id: "root", runner_id: "runner_root" }),
  row("sub1a", { parent_session_id: "sub1", runner_id: "runner_root" }),
  row("sub2", { parent_session_id: "root", archived: true }),
  row("sub3", { parent_session_id: "root" }),
  row("sub4", { parent_session_id: "root", host_id: null, runner_id: null }),
  row("other", { permission_level: 1, owner: "user_else" }),
  row("otherSub", { parent_session_id: "other", permission_level: 1, owner: "user_else" }),
  row("rep", { family: { id: "fam", representative_id: "rep" } as Conversation["family"] }),
  row("member", { family: { id: "fam", representative_id: "rep" } as Conversation["family"] }),
];

describe("permissions", () => {
  it("lets editors and owners control a session, not viewers or unknown access", () => {
    expect(canControlSession(row("a", { permission_level: 2 }), VIEWER)).toBe(true);
    expect(canControlSession(row("a", { permission_level: 1 }), VIEWER)).toBe(false);
    expect(canControlSession(row("a", { permission_level: null }), VIEWER)).toBe(true);
    expect(
      canControlSession(row("a", { permission_level: null, owner: "user_else" }), VIEWER),
    ).toBe(false);
    expect(canControlSession(row("a", { permission_level: NO_KNOWN_ACCESS }), VIEWER)).toBe(false);
  });

  it("gives fetched sub-agents their parent's access but never a runner it didn't report", () => {
    const child = (id: string, parent: string) =>
      childSessionRow(
        {
          id,
          title: id,
          task_summary: null,
          tool: "worker",
          session_name: id,
          current_task_status: "running",
          busy: true,
          last_message_preview: null,
          pending_elicitations_count: 0,
        },
        parent,
      );
    const readOnlyParent = row("ro", { permission_level: 1, owner: "user_else" });
    const ownedParent = row("mine");
    const inherited = withInheritedAccess(
      [readOnlyParent, ownedParent],
      [
        child("roKid", "ro"),
        child("roGrandkid", "roKid"),
        child("mineKid", "mine"),
        child("lost", "gone"),
      ],
    );
    const byId = new Map(inherited.map((kid) => [kid.id, kid]));
    expect(canControlSession(byId.get("roKid")!, VIEWER)).toBe(false);
    expect(canControlSession(byId.get("roGrandkid")!, VIEWER)).toBe(false);
    expect(canControlSession(byId.get("mineKid")!, VIEWER)).toBe(true);
    expect(canControlSession(byId.get("lost")!, VIEWER)).toBe(false);
    expect(byId.get("mineKid")).not.toHaveProperty("runner_id");
    expect(byId.get("mineKid")).not.toHaveProperty("host_id");
    // A sub-agent is stoppable without a known runner: the server finds it.
    expect(canStopSession(byId.get("mineKid")!, VIEWER)).toBe(true);
  });

  it("offers Cancel turn only while a turn runs", () => {
    expect(hasActiveTurn(row("a", { status: "running" }))).toBe(true);
    expect(hasActiveTurn(row("a", { status: "idle" }))).toBe(false);
    expect(hasActiveTurn(row("a", { status: "running", archived: true }))).toBe(false);
  });

  it("stops host- or wrapper-backed sessions and sub-agents, the one rule for every stop", () => {
    expect(canStopSession(row("a", { host_id: null, runner_id: null }), VIEWER)).toBe(false);
    expect(canStopSession(row("a"), VIEWER)).toBe(true);
    expect(
      canStopSession(row("a", { host_id: null, runner_id: null, parent_session_id: "p" }), VIEWER),
    ).toBe(true);
    expect(canStopSession(row("a", { archived: true }), VIEWER)).toBe(false);
    expect(canStopSession(row("a", { permission_level: 1 }), VIEWER)).toBe(false);
  });
});

describe("planStop", () => {
  const plan = (picks: string[], extra: Conversation[] = []) =>
    planStop(forestOf([...extra, ...rows]), picks, VIEWER);

  it("drops only sessions on the same known runner as a kept top-level ancestor", () => {
    // sub1 and sub1a share root's runner; sub3 has its own; sub4's is unknown.
    expect(plan(subtreeStopPicks(forestOf(rows), "root"))).toEqual({
      targets: ["root", "sub3", "sub4"],
      orchestrators: [],
    });
  });

  it("still stops a sub-agent on its own runner", () => {
    expect(plan(["root", "sub3"]).targets).toEqual(["root", "sub3"]);
  });

  it("never drops a session whose runner is unknown", () => {
    const unknown = [
      row("root", { runner_id: "runner_root" }),
      row("sub1", { parent_session_id: "root", host_id: null, runner_id: null }),
    ];
    expect(plan(["sub1", "root"], unknown).targets).toEqual(["root", "sub1"]);
  });

  it("keeps a session under a non-top-level ancestor, even on the same runner", () => {
    expect(plan(subtreeStopPicks(forestOf(rows), "sub1")).targets).toEqual(["sub1", "sub1a"]);
  });

  it("keeps nested members, which run on their own runners", () => {
    expect(plan(subtreeStopPicks(forestOf(rows), "rep")).targets).toEqual(["rep", "member"]);
  });

  it("drops picks the viewer can't stop and those on a kept ancestor's runner", () => {
    expect(plan(["sub2", "other", "otherSub", "sub1a", "root", "missing"])).toEqual({
      targets: ["root"],
      orchestrators: [],
    });
  });

  it("sets a working orchestrator aside, and stops what's under it one by one", () => {
    expect(
      plan(subtreeStopPicks(forestOf(rows), "root"), [row("root", { status: "running" })]),
    ).toEqual({
      targets: ["sub1", "sub3", "sub4", "sub1a"],
      orchestrators: ["root"],
    });
  });

  it("is empty for a session not on the graph", () => {
    expect(subtreeStopPicks(forestOf(rows), "missing")).toEqual([]);
    expect(plan([])).toEqual({ targets: [], orchestrators: [] });
  });
});

describe("awaitingSessionIds", () => {
  it("lists waiting sessions the viewer may answer, in the given order", () => {
    const forest = forestOf([
      row("a", { pending_elicitations_count: 1 }),
      row("b", { blocked_on: "permission prompt" }),
      row("c", { pending_elicitations_count: 2, permission_level: 1 }),
      row("d"),
    ]);
    expect(awaitingSessionIds(forest, ["d", "c", "b", "a"], VIEWER)).toEqual(["b", "a"]);
  });
});

describe("contextGauge", () => {
  it.each([
    [40_000, 100_000, "normal"],
    [80_000, 100_000, "normal"],
    [80_001, 100_000, "warning"],
    [95_000, 100_000, "warning"],
    [95_001, 100_000, "destructive"],
  ] as const)("reads %i of %i as %s", (used, window, tone) => {
    expect(contextGauge(used, window)?.tone).toBe(tone);
  });

  it("clamps an overfull window to a full bar", () => {
    expect(contextGauge(250_000, 200_000)).toMatchObject({ ratio: 1, tone: "destructive" });
  });

  it("is hidden when either number is unknown", () => {
    expect(contextGauge(null, 200_000)).toBeNull();
    expect(contextGauge(1_000, null)).toBeNull();
    expect(contextGauge(1_000, 0)).toBeNull();
    expect(contextGauge(undefined, undefined)).toBeNull();
  });
});

describe("costs", () => {
  // `agent_costs` reports inclusive totals: root's 1.00 already includes sub1's 0.40.
  const rootCosts: AgentCosts = new Map([
    ["root", { costUsd: 1, estimated: false }],
    ["sub1", { costUsd: 0.4, estimated: false }],
    ["sub1a", { costUsd: 0.1, estimated: true }],
  ]);
  const otherCosts: AgentCosts = new Map([["other", { costUsd: 0.25, estimated: false }]]);
  const costsByRoot = new Map([
    ["root", rootCosts],
    ["other", otherCosts],
  ]);

  it("prices a sub-agent from its top-level session's tree", () => {
    const forest = forestOf(rows);
    expect(costRootOf(forest, "sub1a")).toBe("root");
    expect(costRootOf(forest, "root")).toBe("root");
    expect(cardCost(forest, "sub1", costsByRoot)).toEqual({ costUsd: 0.4, estimated: false });
    expect(cardCost(forest, "sub1a", costsByRoot)).toEqual({ costUsd: 0.1, estimated: true });
  });

  it("shows a card's inclusive total as is, never adding its children's", () => {
    expect(cardCost(forestOf(rows), "root", costsByRoot)?.costUsd).toBe(1);
  });

  it("sums only each tree's root, so sub-agents aren't counted twice", () => {
    const total = totalCost(forestOf(rows), ["root", "sub1", "sub1a", "other"], costsByRoot);
    expect(total).toEqual({ costUsd: 1.25, estimated: false, priced: 2 });
  });

  it("counts a tree once when only its sub-agents are shown", () => {
    expect(totalCost(forestOf(rows), ["sub1", "sub1a"], costsByRoot)?.costUsd).toBe(1);
  });

  it("is unknown without any priced tree", () => {
    expect(totalCost(forestOf(rows), ["root"], new Map())).toBeNull();
    expect(cardCost(forestOf(rows), "sub2", costsByRoot)).toBeNull();
  });
});
