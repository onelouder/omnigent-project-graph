// The approvals drawer: a waiting session's pending prompts, each rendered by
// the shared ApprovalCard and resolved with one explicit click. Resolves as the
// Inbox does: hide the prompt at once, POST the verdict, then refetch; a failed
// POST brings the prompt back with an error.

import { useRef, useState } from "react";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { ApprovalCard, type SubmitApprovalFn } from "@/components/blocks/ApprovalCard";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/hooks/useConversations";
import { clearAskUserQuestionDraft } from "@/lib/askUserQuestionDrafts";
import { collectInboxItems, type InboxItem } from "@/lib/inbox";
import {
  acknowledgeLocalElicitationResolution,
  affectedSessionIds,
  beginLocalElicitationResolution,
  cancelLocalElicitationResolution,
} from "@/lib/localElicitationResolutions";
import { ApiError, approve, getSession, type ElicitResult } from "@/lib/sessionsApi";
import type { Session } from "@/lib/types";
import { conversationDisplayLabel } from "@/shell/sidebarNav";

const NATIVE_RECHECK_MS = 1000;

/** Prompts Omnigent mirrors appear here; a prompt that stays in the agent's terminal can't. */
export const UNMIRRORED_PROMPT_NOTE =
  "Only prompts Omnigent mirrors show here. One that stays in the agent's terminal needs the session itself.";

/** The resolve body, as the Inbox and approval page send it. */
export function elicitResult(
  action: ElicitResult["action"],
  content?: Record<string, unknown>,
  meta?: Record<string, unknown>,
): ElicitResult {
  return {
    action,
    ...(content === undefined ? {} : { content }),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

/** An answer sent from the drawer: its prompt hides until the session's state is re-read. */
export interface PromptSubmission {
  /** The native delivery attempt it answered, if the prompt had one. */
  attempt: string | undefined;
  /** When the POST settled; null while it is in flight. */
  settledAt: number | null;
}

/**
 * The prompts to show, given what the drawer has answered. An answered prompt
 * hides while its POST is in flight and until a snapshot read after it settled;
 * if that snapshot still lists it, or lists a new delivery attempt, it shows
 * again with the card's retry controls.
 */
export function visiblePrompts(
  items: readonly InboxItem[],
  submissions: ReadonlyMap<string, PromptSubmission>,
  snapshotReadAt: number,
): InboxItem[] {
  return items.filter((item) => {
    const submission = submissions.get(item.elicitation.elicitationId);
    if (!submission) return true;
    if (item.elicitation.nativeDelivery?.attempt !== submission.attempt) return true;
    return submission.settledAt !== null && snapshotReadAt >= submission.settledAt;
  });
}

/** A resolve the server refused because the prompt is already gone. */
function isAlreadyResolved(failure: unknown): boolean {
  return failure instanceof ApiError && (failure.status === 404 || failure.status === 409);
}

function hasNativeDelivery(session: Session | undefined): boolean {
  return (
    session?.pendingElicitations?.some(
      (event) => (event.params as Record<string, unknown> | undefined)?.native_delivery,
    ) === true
  );
}

export function ProjectGraphApprovals({
  conversation,
  waitingCount,
  onStep,
  onOpenSession,
  onClose,
}: {
  conversation: Conversation;
  /** Sessions waiting on the viewer, to step between. */
  waitingCount: number;
  onStep: (step: 1 | -1) => void;
  onOpenSession: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const id = conversation.id;
  const snapshot = useQuery({
    queryKey: [
      "project-graph-elicitations",
      id,
      conversation.pending_elicitations_count ?? 0,
      conversation.updated_at,
    ],
    queryFn: () => getSession(id),
    retry: 1,
    // A native prompt can re-park; keep checking until its delivery settles.
    refetchInterval: (query: Query<Session>) =>
      hasNativeDelivery(query.state.data) ? NATIVE_RECHECK_MS : false,
  });
  const [submissions, setSubmissions] = useState<ReadonlyMap<string, PromptSubmission>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());

  const items = snapshot.data
    ? visiblePrompts(
        collectInboxItems([
          { row: conversation, pendingElicitations: snapshot.data.pendingElicitations ?? [] },
        ]),
        submissions,
        snapshot.dataUpdatedAt,
      )
    : [];
  const setSubmission = (elicitationId: string, submission: PromptSubmission | null) =>
    setSubmissions((previous) => {
      const next = new Map(previous);
      if (submission) next.set(elicitationId, submission);
      else next.delete(elicitationId);
      return next;
    });
  // Settle a submission, then re-read the prompts: one still pending shows again.
  const reconcile = async (elicitationId: string, attempt: string | undefined) => {
    const queryKey = ["project-graph-elicitations", id];
    // A read that started before the answer landed mustn't count as fresh.
    await queryClient.cancelQueries({ queryKey });
    setSubmission(elicitationId, { attempt, settledAt: Date.now() });
    void queryClient.invalidateQueries({ queryKey });
  };

  const submitFor =
    (item: InboxItem): SubmitApprovalFn =>
    (elicitationId, action, content, meta) => {
      if (inFlight.current.has(elicitationId)) return;
      inFlight.current.add(elicitationId);
      setError(null);
      const attempt = item.elicitation.nativeDelivery?.attempt;
      setSubmission(elicitationId, { attempt, settledAt: null });
      const hold = beginLocalElicitationResolution(
        elicitationId,
        affectedSessionIds(
          [item.row.id, item.resolveSessionId],
          (known) => queryClient.getQueryData<Session>(["session", known])?.parentSessionId,
        ),
        { nativeDelivery: Boolean(item.elicitation.nativeDelivery) },
      );
      void approve(item.resolveSessionId, elicitationId, elicitResult(action, content, meta)).then(
        () => {
          inFlight.current.delete(elicitationId);
          acknowledgeLocalElicitationResolution(elicitationId, hold);
          clearAskUserQuestionDraft(elicitationId);
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          void queryClient.invalidateQueries({ queryKey: ["project-sessions"] });
          void reconcile(elicitationId, attempt);
        },
        (failure: unknown) => {
          inFlight.current.delete(elicitationId);
          cancelLocalElicitationResolution(elicitationId, hold);
          if (isAlreadyResolved(failure)) {
            // Answered elsewhere (or timed out) first: nothing for the viewer to fix.
            void reconcile(elicitationId, attempt);
            return;
          }
          setSubmission(elicitationId, null);
          setError(
            failure instanceof Error && failure.message
              ? `Couldn't send that answer: ${failure.message}`
              : "Couldn't send that answer. Try again.",
          );
        },
      );
    };

  const title = conversationDisplayLabel(conversation);
  const terminalOnly =
    snapshot.isSuccess && items.length === 0 && submissions.size === 0 && conversation.blocked_on;
  return (
    <aside
      aria-label={`Approvals for ${title}`}
      data-testid="project-graph-approvals"
      // Keys typed in a prompt's form stay in the drawer.
      onKeyDown={(event) => event.stopPropagation()}
      className="menu-surface pointer-events-auto absolute top-3 right-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[400px] flex-col overflow-hidden rounded-xl shadow-card"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Awaiting you
          </p>
          <p className="truncate text-sm font-medium" title={title}>
            {title}
          </p>
        </div>
        {waitingCount > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous waiting session"
              onClick={() => onStep(-1)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next waiting session"
              onClick={() => onStep(1)}
            >
              <ChevronDownIcon />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open session"
          title="Open session"
          onClick={onOpenSession}
        >
          <ExternalLinkIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close approvals" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3 text-sm">
        {snapshot.isPending && <p className="text-muted-foreground">Loading prompts…</p>}
        {snapshot.isError && (
          <p role="alert" className="text-destructive">
            Couldn’t load this session’s prompts.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {items.map((item) => (
          <ApprovalCard
            key={item.elicitation.elicitationId}
            elicitationId={item.elicitation.elicitationId}
            message={item.elicitation.message}
            phase={item.elicitation.phase}
            policyName={item.elicitation.policyName}
            contentPreview={item.elicitation.contentPreview}
            requestedSchema={item.elicitation.requestedSchema}
            url={item.elicitation.url}
            nativeDelivery={item.elicitation.nativeDelivery}
            status="pending"
            response={null}
            askUserQuestion={item.elicitation.askUserQuestion}
            exitPlanMode={item.elicitation.exitPlanMode}
            fileEdit={item.elicitation.fileEdit}
            codexCommand={item.elicitation.codexCommand}
            allowAllEdits={item.elicitation.allowAllEdits}
            allowAutoMode={item.elicitation.allowAutoMode}
            permissionDirectories={item.elicitation.permissionDirectories}
            rememberScope={item.elicitation.rememberScope}
            codexPersistModes={item.elicitation.codexPersistModes}
            agyPermission={item.elicitation.agyPermission}
            onSubmit={submitFor(item)}
            requester={
              item.resolveSessionId !== id
                ? { sessionId: item.resolveSessionId, ancestorSessionId: id }
                : null
            }
            className="bg-card-solid"
          />
        ))}
        {snapshot.isSuccess && items.length === 0 && (
          <p className="text-muted-foreground">
            {terminalOnly
              ? `This session is waiting in the agent's terminal (${conversation.blocked_on}).`
              : submissions.size > 0
                ? "Answered. Waiting for the session to pick it up."
                : "Nothing is waiting here any more."}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{UNMIRRORED_PROMPT_NOTE}</p>
      </div>
    </aside>
  );
}
