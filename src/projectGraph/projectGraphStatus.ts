// The board's status lanes and search rule, shared by the graph's cards.

import type { Conversation } from "@/hooks/useConversations";
import { getSessionState, withUnreadState, type SessionState } from "@/hooks/useSessionState";
import { isConversationUnseen } from "@/hooks/useUnseenConversations";
import { TERMINAL_PROMPT_BLOCKED_ON } from "@/lib/events";
import { hasSessionDraft } from "@/lib/sessionDrafts";
import { showsUnreadFor } from "@/lib/sessionMute";
import {
  filterConversations,
  getConversationAgentType,
  statusBucket,
  type StatusBucket,
} from "@/shell/sidebarNav";

export function isUnseen(row: Conversation): boolean {
  return isConversationUnseen(row.id, row.updated_at, row.status);
}

/** The board's lane for a session (as `ProjectKanbanBoard`'s `columnOf`). */
export function columnOf(row: Conversation): StatusBucket {
  return statusBucket(row, showsUnreadFor(row, isUnseen(row)), hasSessionDraft(row.id));
}

/** A card's state badge, composed as the board's cards compose it: unread outranks background work. */
export function cardSessionState(row: Conversation): SessionState | null {
  return withUnreadState(getSessionState(row), showsUnreadFor(row, isUnseen(row)));
}

export type StatusPillTone = "attention" | "working" | "unread" | "error" | "muted";

export interface StatusPillVisual {
  label: string;
  tone: StatusPillTone;
  /** The tooltip: the board badge's wording for the same state. */
  title: string;
  running?: boolean;
}

// As `SessionStateBadge`: the runner infers a blocked terminal prompt from the
// screen, so that reason stays tentative.
function awaitingTooltip(count: number, terminalReason: string | undefined): string {
  if (terminalReason === TERMINAL_PROMPT_BLOCKED_ON) {
    return "May need your input in the agent's terminal";
  }
  if (terminalReason) return `Waiting for you in the agent's terminal (${terminalReason})`;
  return count === 1 ? "1 approval prompt waiting" : `${count} approval prompts waiting`;
}

/**
 * A card's status pill: the board badge's state distinctions and wording
 * (approval vs. an inferred terminal prompt, foreground vs. background work),
 * falling back to the session's lane when it has no live state.
 */
export function statusPill(state: SessionState | null, bucket: StatusBucket): StatusPillVisual {
  switch (state?.kind) {
    case "awaiting":
      return {
        label:
          state.terminalReason === TERMINAL_PROMPT_BLOCKED_ON ? "May need input" : "Needs response",
        tone: "attention",
        title: awaitingTooltip(state.count, state.terminalReason),
      };
    case "running":
      return {
        label: "Working",
        tone: "working",
        title: state.background ? "Working in the background" : "Session running",
        running: true,
      };
    case "starting":
      return { label: "Starting", tone: "working", title: "Session starting up", running: true };
    case "error":
      return { label: "Error", tone: "error", title: "Latest message is an error" };
    case "disconnected":
      return { label: "Offline", tone: "muted", title: "Host disconnected" };
    case "unseen":
      return { label: "Unread", tone: "unread", title: "New messages" };
    default:
      break;
  }
  switch (bucket) {
    case "Needs attention":
      return { label: "Needs you", tone: "attention", title: "Needs your attention" };
    case "Working":
      return { label: "Working", tone: "working", title: "Session running", running: true };
    case "Unread":
      return { label: "Unread", tone: "unread", title: "New messages" };
    case "Draft":
      return { label: "Draft", tone: "muted", title: "Unsent draft" };
    default:
      return { label: "Done", tone: "muted", title: "Done" };
  }
}

/** Lane tags, tinted after the sidebar's status markers (as the board's). */
export const BUCKET_TAG_CLASS: Record<StatusBucket, string> = {
  Draft: "bg-muted text-muted-foreground",
  "Needs attention": "bg-warning/15 text-warning",
  Unread: "bg-brand-accent/15 text-brand-accent",
  Working: "bg-session-active/15 text-session-active",
  Done: "bg-success/15 text-success",
};

/** Status chips in the toolbar, most urgent first. */
export const GRAPH_STATUS_CHIPS: readonly StatusBucket[] = [
  "Needs attention",
  "Working",
  "Unread",
  "Done",
];

/** The session is parked on the viewer: an approval card or a terminal prompt. */
export function isWaitingOnUser(row: Conversation): boolean {
  return (row.pending_elicitations_count ?? 0) > 0 || Boolean(row.blocked_on);
}

/**
 * Whether a session matches the graph's search: the sidebar's title-or-id rule,
 * or its status lane, harness, branch or PR number.
 */
export function matchesGraphSearch(
  row: Conversation,
  bucket: StatusBucket,
  searchQuery: string,
): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return false;
  if (filterConversations([row], query).length > 0) return true;
  const pullRequest = row.pull_request?.number;
  const haystacks = [
    bucket,
    getConversationAgentType(row),
    row.harness ?? "",
    row.git_branch ?? "",
    pullRequest !== undefined ? `#${pullRequest}` : "",
  ];
  return haystacks.some((text) => text.toLocaleLowerCase().includes(query));
}

/** Splits `text` around case-insensitive matches of `query`, for `<mark>` highlighting. */
export function splitSearchMatches(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const haystack = text.toLocaleLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
