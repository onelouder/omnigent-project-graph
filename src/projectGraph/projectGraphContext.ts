// Shared state between the graph view and its memoized cards and edges: stable
// actions through context, and fast-changing pointer state through a store.

import { createContext, useContext } from "react";
import { create } from "zustand";

export type OpenTarget = "auto" | "quick" | "full";

export interface ProjectGraphActions {
  projectName: string;
  /** Open a session: the quick view by default, the full page for "full" or a modifier click. */
  openSession: (sessionId: string, target: OpenTarget) => void;
  /** A plain, shift or modifier click on a card. */
  clickCard: (
    sessionId: string,
    event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => void;
  toggleCollapse: (sessionId: string) => void;
  loadChildren: (sessionId: string) => void;
  focusSubtree: (sessionId: string) => void;
  jumpToSession: (sessionId: string) => void;
  /** Open the approvals drawer on a waiting session. */
  openApprovals: (sessionId: string) => void;
  /** Ask to cancel a session's running turn (confirmed first). */
  cancelTurn: (sessionId: string) => void;
  /** Ask to stop a session and its loaded descendants (confirmed first). */
  stopSubtree: (sessionId: string) => void;
  /** The canvas's next Escape step (search, filter, selection, focus), else close the quick view. */
  escape: () => void;
}

const noop = () => {};

export const ProjectGraphActionsContext = createContext<ProjectGraphActions>({
  projectName: "",
  openSession: noop,
  clickCard: noop,
  toggleCollapse: noop,
  loadChildren: noop,
  focusSubtree: noop,
  jumpToSession: noop,
  openApprovals: noop,
  cancelTurn: noop,
  stopSubtree: noop,
  escape: noop,
});

export function useProjectGraphActions(): ProjectGraphActions {
  return useContext(ProjectGraphActionsContext);
}

interface ProjectGraphPointerState {
  /** Panning, zooming or dragging: hover cards stay shut. */
  interacting: boolean;
  /** A card menu is open: hover cards stay shut. */
  menuOpen: boolean;
  /** Ends of the fork edge whose pill is hovered. */
  hoveredFork: { source: string; target: string } | null;
  setInteracting: (interacting: boolean) => void;
  setMenuOpen: (open: boolean) => void;
  setHoveredFork: (fork: { source: string; target: string } | null) => void;
}

export const useProjectGraphPointerStore = create<ProjectGraphPointerState>((set) => ({
  interacting: false,
  menuOpen: false,
  hoveredFork: null,
  setInteracting: (interacting) => set({ interacting }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setHoveredFork: (hoveredFork) => set({ hoveredFork }),
}));
