// The hover card's details. Usage (model, cost) and the last reply load only
// while the card is open, never per node up front.

import { useQuery } from "@tanstack/react-query";
import { GitBranchIcon, GitForkIcon, GitPullRequestIcon } from "lucide-react";
import { SessionStateBadge } from "@/components/SessionStateBadge";
import { Badge } from "@/components/ui/badge";
import { agentCostLabel } from "@/hooks/useAgentCosts";
import { formatSessionCostUsd, formatTokenCount } from "@/lib/formatCost";
import { fetchLastAssistantMessage, leadingSentences } from "@/lib/lastAssistantText";
import { getSessionUsage } from "@/lib/sessionsApi";
import { cn } from "@/lib/utils";
import { conversationDisplayLabel, getConversationAgentType } from "@/shell/sidebarNav";
import { SessionUpdatedLabel } from "@/shell/sessionRowMeta";
import type { SessionCardData } from "./projectGraphTypes";
import { BUCKET_TAG_CLASS, cardSessionState } from "./projectGraphStatus";
import { useCompactionCount } from "./useProjectGraphOverlays";

const SNIPPET_SENTENCES = 3;

function blockedReason(data: SessionCardData): string | null {
  const { conversation } = data;
  const pending = conversation.pending_elicitations_count ?? 0;
  if (pending > 0)
    return pending === 1 ? "Waiting on 1 approval" : `Waiting on ${pending} approvals`;
  if (conversation.blocked_on) return `Waiting in the terminal: ${conversation.blocked_on}`;
  if (conversation.status === "failed") return "The last turn failed";
  return null;
}

function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-xs leading-5")}>
        {children}
      </dd>
    </div>
  );
}

export function ProjectGraphHoverDetails({ data, open }: { data: SessionCardData; open: boolean }) {
  const { conversation, bucket, descendants } = data;
  const state = cardSessionState(conversation);
  const usage = useQuery({
    queryKey: ["project-graph-usage", conversation.id, conversation.updated_at],
    queryFn: ({ signal }) => getSessionUsage(conversation.id, { signal }),
    enabled: open && !conversation.parent_session_id,
    staleTime: 60_000,
    retry: false,
  });
  const snippet = useQuery({
    queryKey: ["project-graph-last-response", conversation.id, conversation.updated_at],
    queryFn: async () => (await fetchLastAssistantMessage(conversation.id)) ?? null,
    enabled: open && conversation.status !== "running",
    staleTime: Infinity,
    retry: false,
  });
  const compactions = useCompactionCount(conversation.id, conversation.updated_at, open);
  const costHidden = usage.data?.costHidden === true;
  const byModel = Object.entries(usage.data?.usageByModel ?? {});
  const models = byModel.map(([model]) => model);
  // The overlay's inclusive cost (marked when estimated), else the snapshot's subtree total.
  const overlayCost = agentCostLabel(data.cost ?? undefined);
  const snapshotCost =
    usage.data && !costHidden && usage.data.totalCostUsd !== null
      ? formatSessionCostUsd(usage.data.totalCostUsd)
      : null;
  const cost = costHidden ? null : (overlayCost ?? snapshotCost);
  const reason = blockedReason(data);
  const pullRequest = conversation.pull_request;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 font-medium break-words text-foreground">
          {conversationDisplayLabel(conversation)}
        </p>
        <Badge className={cn("shrink-0 border-transparent", BUCKET_TAG_CLASS[bucket])}>
          {bucket}
        </Badge>
        {state && state.kind !== "running" && <SessionStateBadge state={state} />}
      </div>
      {reason && <p className="text-warning">{reason}</p>}
      {snippet.data && (
        <p className="line-clamp-3 text-muted-foreground">
          {leadingSentences(snippet.data, SNIPPET_SENTENCES)}
        </p>
      )}
      <dl className="flex flex-col gap-0.5">
        <Row label="Harness">
          {getConversationAgentType(conversation)}
          {models.length > 0 && (
            <span className="text-muted-foreground"> · {models.join(", ")}</span>
          )}
        </Row>
        {cost !== null && (
          <Row label="Cost">
            <span data-testid="project-graph-hover-cost">
              {cost}
              {data.cost?.estimated && <span className="text-muted-foreground"> (estimate)</span>}
              {descendants.total > 0 && (
                <span className="text-muted-foreground"> · incl. sub-agents</span>
              )}
            </span>
          </Row>
        )}
        {!costHidden && byModel.length > 1 && (
          <Row label="By model">
            <ul className="flex flex-col" data-testid="project-graph-hover-models">
              {byModel.map(([model, modelUsage]) => (
                <li key={model} className="flex min-w-0 gap-2">
                  <span className="min-w-0 flex-1 truncate">{model}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {modelUsage.totalCostUsd !== null
                      ? formatSessionCostUsd(modelUsage.totalCostUsd)
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        )}
        {data.context && (
          <Row label="Context">
            <span className="tabular-nums">
              {Math.round(data.context.ratio * 100)}% · {formatTokenCount(data.context.usedTokens)}{" "}
              of {formatTokenCount(data.context.windowTokens)}
            </span>
          </Row>
        )}
        {compactions.data && compactions.data.count > 0 && (
          <Row label="Compacted">
            <span className="tabular-nums">
              {compactions.data.count}
              {compactions.data.more && "+"}{" "}
              {compactions.data.count === 1 && !compactions.data.more ? "time" : "times"}
            </span>
          </Row>
        )}
        {data.treeKind && (
          <Row label="Kind">{data.treeKind === "nested" ? "Nested agent" : "Sub-agent"}</Row>
        )}
        {conversation.workspace && (
          <Row label="Workspace" mono>
            <span title={conversation.workspace}>{conversation.workspace}</span>
          </Row>
        )}
        {conversation.git_branch && (
          <Row label="Branch" mono>
            <GitBranchIcon aria-hidden className="mr-1 inline size-3" />
            {conversation.git_branch}
          </Row>
        )}
        {pullRequest && (
          <Row label="PR">
            <GitPullRequestIcon aria-hidden className="mr-1 inline size-3" />#{pullRequest.number}
            {pullRequest.title && ` ${pullRequest.title}`}
            {pullRequest.state && (
              <span className="text-muted-foreground"> · {pullRequest.state.toLowerCase()}</span>
            )}
          </Row>
        )}
        {conversation.created_at > 0 && (
          <Row label="Created">
            <SessionUpdatedLabel updatedAt={conversation.created_at} />
          </Row>
        )}
        {conversation.updated_at > 0 && (
          <Row label="Updated">
            <SessionUpdatedLabel updatedAt={conversation.updated_at} />
          </Row>
        )}
        {data.forkSourceLabel && (
          <Row label="Forked">
            <GitForkIcon aria-hidden className="mr-1 inline size-3" />
            from {data.forkSourceLabel}
          </Row>
        )}
      </dl>
      {descendants.total > 0 && (
        <p className="text-muted-foreground tabular-nums">
          {descendants.total} nested · {descendants.working} working
        </p>
      )}
    </div>
  );
}
