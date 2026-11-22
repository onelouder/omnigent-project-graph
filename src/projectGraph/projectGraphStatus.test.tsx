import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStateBadge } from "@/components/SessionStateBadge";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionState } from "@/hooks/useSessionState";
import { TERMINAL_PROMPT_BLOCKED_ON } from "@/lib/events";
import { statusPill } from "./projectGraphStatus";

afterEach(cleanup);

/** The board badge's accessible name and visible text for `state`. */
function renderedBadge(state: SessionState) {
  render(
    <TooltipProvider>
      <SessionStateBadge state={state} />
    </TooltipProvider>,
  );
  const badge = screen.getByTestId("session-state-badge");
  return { name: badge.getAttribute("aria-label"), text: badge.textContent ?? "" };
}

describe("statusPill", () => {
  it.each([
    ["an approval prompt", { kind: "awaiting", count: 2 }],
    [
      "an inferred terminal prompt",
      { kind: "awaiting", count: 0, terminalReason: TERMINAL_PROMPT_BLOCKED_ON },
    ],
    ["a named terminal wait", { kind: "awaiting", count: 0, terminalReason: "permission" }],
    ["foreground work", { kind: "running" }],
    ["background work", { kind: "running", background: true }],
    ["start-up", { kind: "starting" }],
    ["an error", { kind: "error" }],
    ["a disconnected host", { kind: "disconnected" }],
    ["new messages", { kind: "unseen" }],
  ] as const)("words %s as the board badge does", (_label, state) => {
    const badge = renderedBadge(state);
    const pill = statusPill(state, "Done");
    expect(pill.title).toBe(badge.name);
    // The badge shows text only for prompts; that text is the pill's label.
    if (badge.text) expect(pill.label).toBe(badge.text);
  });

  it("falls back to the lane without a live state", () => {
    expect(statusPill(null, "Done")).toMatchObject({ label: "Done", tone: "muted" });
    expect(statusPill(null, "Needs attention")).toMatchObject({ tone: "attention" });
  });
});
