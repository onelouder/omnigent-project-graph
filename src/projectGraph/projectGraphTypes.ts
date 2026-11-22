// Data the graph view hands each card.

import type { Node } from "@xyflow/react";
import type { AgentCost } from "@/hooks/useAgentCosts";
import type { Conversation } from "@/hooks/useConversations";
import type { ContextGauge } from "./projectGraphControls";
import type { StatusBucket } from "@/shell/sidebarNav";
import type { DescendantSummary } from "./projectGraphForest";
import type { ProjectGraphNodeData } from "./projectGraphLayout";

/** Live card state the view computes for each visible session. */
export interface SessionCardData extends ProjectGraphNodeData {
  conversation: Conversation;
  bucket: StatusBucket;
  /** The edge to this card's tree parent, or null for a root. */
  treeKind: "subagent" | "nested" | null;
  /** Known tree children, visible or not. */
  childCount: number;
  /** The edge kind to the first known child, naming the count of sessions below. */
  childKind: "subagent" | "nested" | null;
  collapsed: boolean;
  descendants: DescendantSummary;
  /** Sub-agents not fetched yet; the pill offers to load them. */
  canLoadChildren: boolean;
  loadingChildren: boolean;
  search: "match" | "ancestor" | "dim" | null;
  searchQuery: string;
  /** Open in the quick view or picked for a bulk action. */
  selected: boolean;
  keyboardFocused: boolean;
  /** Fork source on the graph, to jump to. */
  forkSourceOnGraph: string | null;
  /** Fork source off the graph, named for the "forked from" chip. */
  externalForkLabel: string | null;
  /** The fork source's title, on the graph or off it. */
  forkSourceLabel: string | null;
  /** An end of the hovered fork edge. */
  forkHighlighted: boolean;
  /** The viewer may approve, cancel, stop and message this session. */
  canControl: boolean;
  /** Sessions a subtree stop would send to (its top-most stoppable ones); 0 without children. */
  subtreeStopCount: number;
  /** The cost overlay is on (the cost may still be loading or unknown). */
  showCost: boolean;
  /** Inclusive cost (own spend plus sub-agents'), when the overlay has it. */
  cost: AgentCost | null;
  /** Context-window use, when the overlay is on and it is known. */
  context: ContextGauge | null;
}

export type SessionCardNode = Node<SessionCardData, "session">;

export const STANDALONE_LABEL_NODE_ID = "project-graph:standalone-label";
export type StandaloneLabelNode = Node<{ count: number }, "standaloneLabel">;

export interface ProjectGraphViewProps {
  projectName: string;
  /** The session open in the quick view. */
  selectedSessionId: string | null;
  /** Whether a plain click opens the quick view; phones open the full page. */
  quickViewEnabled: boolean;
  onCloseQuickView: () => void;
}
