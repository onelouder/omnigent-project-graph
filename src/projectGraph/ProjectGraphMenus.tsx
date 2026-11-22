// Card menus for the graph: graph-only items above the sidebar row's own
// actions (ConversationMenuItems). One host holds the session-action dialogs
// for whichever card's menu opened last, so a hundred cards don't each mount them.

import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  GitForkIcon,
  HandIcon,
  OctagonXIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
  SquareIcon,
} from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useMoveToProject,
  useTogglePinnedConversation,
  type Conversation,
} from "@/hooks/useConversations";
import { markConversationRead, markConversationUnread } from "@/hooks/useUnseenConversations";
import { useViewerId } from "@/hooks/useViewerId";
import { isSingleUserMode } from "@/lib/capabilities";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { isIndentedSibling, isSessionPinned } from "@/lib/sessionFamilies";
import { RenameSessionDialog } from "@/shell/RenameSessionDialog";
import { ConversationMenuItems } from "@/shell/Sidebar";
import { conversationDisplayLabel, isOwnedByViewer } from "@/shell/sidebarNav";
import { useSessionActions } from "@/shell/useSessionActions";
import { canStopSession, hasActiveTurn } from "./projectGraphControls";
import { useProjectGraphActions } from "./projectGraphContext";
import { isUnseen, isWaitingOnUser } from "./projectGraphStatus";

// Context-menu counterparts of the sidebar's dropdown item family.
const CONTEXT_MENU_COMPONENTS = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};
const DROPDOWN_MENU_COMPONENTS = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

type MenuItemsProps = Omit<
  Parameters<typeof ConversationMenuItems>[0],
  "components" | "conversation" | "setMenuOpen"
>;

/** The graph's own Pin item: the shared one hides on desktop behind the row's pin button. */
interface PinAction {
  pinned: boolean;
  toggle: () => void;
}

interface MenuItemsState {
  target: Conversation | null;
  itemProps: MenuItemsProps | null;
  pin: PinAction | null;
}

// The open card's menu props, published by the host for the menu body to read.
const useMenuItemsStore = create<MenuItemsState>(() => ({
  target: null,
  itemProps: null,
  pin: null,
}));

const SetMenuTargetContext = createContext<(conversation: Conversation) => void>(() => {});

/** Point the shared action host at a card whose menu is opening. */
export function useSetMenuTarget(): (conversation: Conversation) => void {
  return useContext(SetMenuTargetContext);
}

function TargetActions({
  conversation,
  projectName,
  onLeave,
}: {
  conversation: Conversation;
  projectName: string;
  onLeave: (sessionId: string) => void;
}) {
  const viewerId = useViewerId();
  const serverInfo = useServerInfo();
  const moveToProject = useMoveToProject();
  const togglePinned = useTogglePinnedConversation();
  const [renameOpen, setRenameOpen] = useState(false);
  const actions = useSessionActions({
    conversation,
    label: conversationDisplayLabel(conversation),
    viewerId,
    serverInfo,
    onLeave: () => onLeave(conversation.id),
    componentIdPrefix: "project_graph.card",
  });
  const pinned = isSessionPinned(conversation);
  const pin: PinAction | null =
    conversation.archived || isIndentedSibling(conversation)
      ? null
      : { pinned, toggle: () => togglePinned.mutate({ id: conversation.id, pinned: !pinned }) };
  // No `onTogglePinned`: the shared items would render a desktop-hidden Pin; the graph's own shows instead.
  const itemProps: MenuItemsProps = {
    isArchived: conversation.archived === true,
    isOwner: isOwnedByViewer(conversation, viewerId),
    sharingOff: serverInfo !== "loading" && serverInfo.sharing_mode === "off",
    isSingleUser: isSingleUserMode(serverInfo),
    // The graph's one stop rule, shared with its bulk and subtree stops.
    canStop: canStopSession(conversation, viewerId),
    canMarkUnread: !isUnseen(conversation),
    currentProject: projectName,
    onMarkUnread: () => markConversationUnread(conversation.id, conversation.updated_at),
    onMarkRead: () => markConversationRead(conversation.id, conversation.updated_at),
    moveToProject,
    setShareOpen: actions.setShareOpen,
    setForkOpen: actions.setForkOpen,
    canCreateAutomation: false,
    setAutomationOpen: actions.setAutomationOpen,
    setIsEditing: setRenameOpen,
    setStopOpen: actions.setStopOpen,
    setDeleteOpen: actions.setDeleteOpen,
    setLeaveOpen: actions.setLeaveOpen,
    runArchive: actions.runArchive,
  };
  // Republished each render so the open menu sees current dialog setters.
  useLayoutEffect(() => {
    useMenuItemsStore.setState({ target: conversation, itemProps, pin });
  });
  useLayoutEffect(
    () => () => useMenuItemsStore.setState({ target: null, itemProps: null, pin: null }),
    [],
  );
  return (
    <>
      {actions.dialogs}
      {renameOpen && (
        <RenameSessionDialog conversation={conversation} open onOpenChange={setRenameOpen} />
      )}
    </>
  );
}

/**
 * Holds the session actions and dialogs for the card whose menu opened last.
 *
 * :param onLeave: Called right before a session is archived, deleted or left.
 */
export function ProjectGraphMenuHost({
  projectName,
  onLeave,
  children,
}: {
  projectName: string;
  onLeave: (sessionId: string) => void;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<Conversation | null>(null);
  return (
    <SetMenuTargetContext.Provider value={setTarget}>
      {children}
      {target !== null && (
        <TargetActions
          // A new target starts with its dialogs shut.
          key={target.id}
          conversation={target}
          projectName={projectName}
          onLeave={onLeave}
        />
      )}
    </SetMenuTargetContext.Provider>
  );
}

/**
 * A card menu's body. Renders once the host points at this card; the menu that
 * contains it sets the target as it opens.
 */
export function ProjectGraphMenuBody({
  conversation,
  kind,
  collapsed,
  hasChildren,
  forkSourceId,
  canControl,
  subtreeStopCount,
  close,
}: {
  conversation: Conversation;
  kind: "context" | "dropdown";
  collapsed: boolean;
  hasChildren: boolean;
  /** The fork source on the graph, when there is one to jump to. */
  forkSourceId: string | null;
  /** The viewer may approve, cancel and stop here. */
  canControl: boolean;
  /** Sessions a subtree stop would send to (its top-most stoppable sessions). */
  subtreeStopCount: number;
  close: () => void;
}) {
  const target = useMenuItemsStore((state) => state.target);
  const itemProps = useMenuItemsStore((state) => state.itemProps);
  const pin = useMenuItemsStore((state) => state.pin);
  const graph = useProjectGraphActions();
  const C = kind === "context" ? CONTEXT_MENU_COMPONENTS : DROPDOWN_MENU_COMPONENTS;
  const id = conversation.id;
  return (
    <>
      <C.Item onSelect={() => graph.openSession(id, "full")} data-testid="project-graph-menu-open">
        <ExternalLinkIcon className="size-3.5" />
        Open session
      </C.Item>
      <C.Item onSelect={() => graph.openSession(id, "quick")}>
        <PanelRightIcon className="size-3.5" />
        Open in quick view
      </C.Item>
      <C.Item onSelect={() => graph.focusSubtree(id)}>
        <CrosshairIcon className="size-3.5" />
        Focus subtree
      </C.Item>
      {hasChildren && (
        <C.Item onSelect={() => graph.toggleCollapse(id)}>
          {collapsed ? (
            <ChevronsUpDownIcon className="size-3.5" />
          ) : (
            <ChevronsDownUpIcon className="size-3.5" />
          )}
          {collapsed ? "Expand subtree" : "Collapse subtree"}
        </C.Item>
      )}
      {forkSourceId !== null && (
        <C.Item onSelect={() => graph.jumpToSession(forkSourceId)}>
          <GitForkIcon className="size-3.5" />
          Jump to fork source
        </C.Item>
      )}
      {canControl && isWaitingOnUser(conversation) && (
        <C.Item onSelect={() => graph.openApprovals(id)} data-testid="project-graph-menu-review">
          <HandIcon className="size-3.5" />
          Review approvals
        </C.Item>
      )}
      {canControl && hasActiveTurn(conversation) && (
        <C.Item onSelect={() => graph.cancelTurn(id)} data-testid="project-graph-menu-cancel-turn">
          <SquareIcon className="size-3.5" />
          Cancel turn
        </C.Item>
      )}
      {canControl && hasChildren && subtreeStopCount > 0 && (
        <C.Item
          onSelect={() => graph.stopSubtree(id)}
          data-testid="project-graph-menu-stop-subtree"
        >
          <OctagonXIcon className="size-3.5" />
          Stop subtree…
        </C.Item>
      )}
      {target?.id === id && pin && (
        <C.Item onSelect={pin.toggle} data-testid="project-graph-menu-pin">
          {pin.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          {pin.pinned ? "Unpin" : "Pin"}
        </C.Item>
      )}
      {target?.id === id && itemProps && (
        <>
          <C.Separator />
          <ConversationMenuItems
            {...itemProps}
            components={C}
            conversation={target}
            setMenuOpen={(open) => {
              if (!open) close();
            }}
          />
        </>
      )}
    </>
  );
}
