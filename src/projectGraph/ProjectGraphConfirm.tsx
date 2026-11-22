// The graph's confirmations, before anything runs: "Cancel turn" interrupts one
// session's turn; "Stop" sends each planned session its own stop and reports
// partial failures; "Archive" archives the picked sessions, which also stops
// any that are running, and reports any that failed.

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showToast } from "@/components/ui/toast";
import {
  BulkConversationMutationError,
  useBulkArchiveConversations,
  type Conversation,
} from "@/hooks/useConversations";
import { readDeleteWorktreesOnArchive } from "@/lib/archiveWorktreePreferences";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { useNavigate } from "@/lib/routing";
import { interrupt, stopSession } from "@/lib/sessionsApi";
import { showArchiveUndoToast } from "@/shell/archiveUndoToast";
import type { StopPlan } from "./projectGraphControls";

export type GraphConfirmRequest =
  | { kind: "cancel"; sessionId: string; title: string }
  | {
      kind: "stop";
      scope: "selected" | "subtree";
      plan: StopPlan;
      /** Titles of the planned sessions, by id. */
      titles: ReadonlyMap<string, string>;
    }
  | {
      kind: "archive";
      rows: readonly Conversation[];
      /** Called with the archived ids once the viewer confirms. */
      onArchive: (ids: string[]) => void;
    };

function sessions(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message ? `: ${error.message}` : "";
}

export interface StopOutcome {
  /** Sessions whose stop the server accepted. */
  stopped: string[];
  /** Every other session, with the server's reason. */
  failed: { id: string; reason: string }[];
}

function failureReason(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : "the stop didn't go through";
}

/**
 * Send each session its own `stop_session`, in parallel. One failing doesn't
 * hold back the rest. Only a success response counts as stopped: a 409 can
 * mean a turn is still running, and a 404 a session the viewer can't reach.
 */
export async function stopEach(ids: readonly string[]): Promise<StopOutcome> {
  const results = await Promise.allSettled(ids.map((id) => stopSession(id)));
  const outcome: StopOutcome = { stopped: [], failed: [] };
  results.forEach((result, index) => {
    const id = ids[index];
    if (result.status === "fulfilled") outcome.stopped.push(id);
    else outcome.failed.push({ id, reason: failureReason(result.reason) });
  });
  return outcome;
}

/** The toast for a stop: all stopped, or which couldn't stop and why. */
export function stopOutcomeMessage(
  { stopped, failed }: StopOutcome,
  titles: ReadonlyMap<string, string>,
): string {
  if (failed.length === 0) return `Stopped ${sessions(stopped.length)}`;
  const reasons = failed
    .map(({ id, reason }) => `${titles.get(id) ?? id} couldn't stop: ${reason}`)
    .join("; ");
  if (stopped.length === 0) return `${reasons}.`;
  return `Stopped ${stopped.length} of ${sessions(stopped.length + failed.length)}. ${reasons}.`;
}

/** The toast for an archive that didn't fully land. */
export function archiveFailureMessage(error: unknown, total: number): string {
  const failed = error instanceof BulkConversationMutationError ? error.failed.length : total;
  const archived = total - failed;
  return archived > 0
    ? `Archived ${archived} of ${sessions(total)}; ${failed} failed.`
    : `Couldn't archive ${sessions(total)}${errorDetail(error)}`;
}

/** What a stop can take down, said in every stop confirmation. */
export const STOP_RUNNER_NOTE =
  "If a session owns its runner, stopping it shuts the runner down, and other sessions on that runner (sub-agents, side chats) stop too, even ones not shown here. Transcripts are kept, and the next message relaunches a stopped session.";

function names(ids: readonly string[], titles: ReadonlyMap<string, string>): string {
  return ids.map((id) => titles.get(id) ?? id).join(", ");
}

/**
 * The graph's cancel, stop and archive actions. `request` opens the
 * confirmation; nothing runs until the viewer confirms it in `dialog`.
 */
export function useProjectGraphControls(): {
  request: (request: GraphConfirmRequest) => void;
  dialog: ReactNode;
} {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const serverInfo = useServerInfo();
  const [pending, setPending] = useState<GraphConfirmRequest | null>(null);
  // Per-dialog choices, reset with each request.
  const [includeOrchestrators, setIncludeOrchestrators] = useState(false);
  const [deleteWorktrees, setDeleteWorktrees] = useState(false);
  const stopMany = useMutation({
    mutationFn: stopEach,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["project-sessions"] });
    },
  });
  const bulkArchive = useBulkArchiveConversations();
  const cancelTurn = useMutation({
    mutationFn: (sessionId: string) => interrupt(sessionId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["project-sessions"] });
    },
  });
  const cleanupSupported = serverInfo !== "loading" && serverInfo.archive_worktree_cleanup === true;

  const request = (next: GraphConfirmRequest) => {
    setIncludeOrchestrators(false);
    // The viewer's saved worktree choice, as the sidebar's archive applies it.
    setDeleteWorktrees(readDeleteWorktreesOnArchive() === true);
    setPending(next);
  };

  const stopIds = (plan: StopPlan) =>
    includeOrchestrators ? [...plan.targets, ...plan.orchestrators] : plan.targets;

  const run = (current: GraphConfirmRequest) => {
    if (current.kind === "cancel") {
      cancelTurn.mutate(current.sessionId, {
        onSuccess: () => showToast(`Cancelled the turn in ${current.title}`),
        onError: (error) => showToast(`Couldn't cancel the turn${errorDetail(error)}`),
      });
      return;
    }
    if (current.kind === "archive") {
      const ids = current.rows.map((row) => row.id);
      const worktreeIds = new Set(
        deleteWorktrees && cleanupSupported
          ? current.rows.filter((row) => row.git_branch != null).map((row) => row.id)
          : [],
      );
      current.onArchive(ids);
      // The sidebar's flow: archive optimistically and offer Undo at once, within
      // the server's teardown grace. A failed session rolls back into the lists;
      // the promise (unlike a per-call callback) still reports it after unmount.
      bulkArchive
        .mutateAsync({ ids, archived: true, deleteWorktreeIds: worktreeIds })
        .catch((error: unknown) => showToast(archiveFailureMessage(error, ids.length)));
      showArchiveUndoToast(queryClient, current.rows, navigate);
      return;
    }
    const { titles } = current;
    stopMany.mutateAsync(stopIds(current.plan)).then(
      (outcome) => showToast(stopOutcomeMessage(outcome, titles)),
      (error: unknown) => showToast(`Couldn't stop the sessions${errorDetail(error)}`),
    );
  };

  let title = "";
  let body: ReactNode = null;
  let extra: ReactNode = null;
  let action = "";
  let disabled = false;
  if (pending?.kind === "cancel") {
    title = "Cancel this turn?";
    body = (
      <>
        This interrupts the turn running in <span className="font-medium">{pending.title}</span>.
        The session stays open for your next message.
      </>
    );
    action = "Cancel turn";
  } else if (pending?.kind === "stop") {
    const { plan, titles } = pending;
    const count = stopIds(plan).length;
    title = count === 0 ? "Nothing to stop yet" : `Stop ${sessions(count)}?`;
    body = (
      <>
        {plan.targets.length > 0 && (
          <span className="mb-2 block">
            {pending.scope === "subtree" ? "Stops the top of this subtree" : "Stops"}:{" "}
            <span className="font-medium">{names(plan.targets, titles)}</span>.
          </span>
        )}
        <span className="block">{STOP_RUNNER_NOTE}</span>
      </>
    );
    if (plan.orchestrators.length > 0) {
      extra = (
        <div
          role="alert"
          data-testid="project-graph-confirm-orchestrators"
          className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <p>
            <span className="font-medium text-warning">Left out: </span>
            {names(plan.orchestrators, titles)}{" "}
            {plan.orchestrators.length === 1 ? "is an orchestrator" : "are orchestrators"} working
            right now. Stopping one ends its whole run and every agent on its runner.
          </p>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={includeOrchestrators}
              onCheckedChange={(checked) => setIncludeOrchestrators(checked === true)}
              aria-label="Also stop the working orchestrators"
            />
            Also stop {plan.orchestrators.length === 1 ? "it" : "them"}
          </label>
        </div>
      );
    }
    action = count === 0 ? "Stop" : count === 1 ? "Stop session" : `Stop ${sessions(count)}`;
    disabled = count === 0;
  } else if (pending?.kind === "archive") {
    const count = pending.rows.length;
    const worktrees = pending.rows.filter((row) => row.git_branch != null).length;
    title = `Archive ${sessions(count)}?`;
    body = (
      <>
        Archiving stops any of {count === 1 ? "it" : "them"} that are running, with their runners
        and sub-agents. You can unarchive sessions later.
      </>
    );
    if (cleanupSupported && worktrees > 0) {
      extra = (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={deleteWorktrees}
            onCheckedChange={(checked) => setDeleteWorktrees(checked === true)}
            aria-label="Also delete their worktrees"
          />
          Also delete {worktrees === 1 ? "its worktree" : `their ${worktrees} worktrees`}
        </label>
      );
    }
    action = count === 1 ? "Archive session" : `Archive ${sessions(count)}`;
  }

  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      {pending && (
        <DialogContent data-testid="project-graph-confirm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{body}</DialogDescription>
          </DialogHeader>
          {extra}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>
              {pending.kind === "archive" ? "Keep" : "Keep running"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              data-testid="project-graph-confirm-action"
              onClick={() => {
                // Close now and run in the background; failures surface as toasts.
                setPending(null);
                run(pending);
              }}
            >
              {action}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return { request, dialog };
}
