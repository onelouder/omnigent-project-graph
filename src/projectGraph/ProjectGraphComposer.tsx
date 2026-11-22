// The composer docked under the canvas while exactly one session is selected:
// sends one plain user message to that session, never to several. On a working
// session it steers, which some harnesses queue until the current turn ends.

import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SendHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CompactKbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { showToast } from "@/components/ui/toast";
import type { Conversation } from "@/hooks/useConversations";
import { isImeCompositionKeyEvent } from "@/lib/ime";
import { describeSendFailure } from "@/lib/sendFailure";
import { sendUserMessage } from "@/lib/sessionsApi";
import { conversationDisplayLabel } from "@/shell/sidebarNav";
import { hasActiveTurn } from "./projectGraphControls";

export const STEER_NOTE =
  "Steering may wait until the current turn ends, depending on the harness.";

export function ProjectGraphComposer({ conversation }: { conversation: Conversation }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const title = conversationDisplayLabel(conversation);
  const steer = hasActiveTurn(conversation);
  const send = useMutation({
    mutationFn: (message: string) => sendUserMessage(conversation.id, message),
    onSuccess: (result) => {
      if (result.denied) {
        setError("A policy blocked the message.");
        return;
      }
      setText("");
      showToast(steer ? `Steered ${title}` : `Sent to ${title}`);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["project-sessions"] });
    },
    onError: (failure) => setError(describeSendFailure(failure).message),
  });
  const message = text.trim();
  const submit = () => {
    if (message === "" || send.isPending) return;
    setError(null);
    send.mutate(message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeCompositionKeyEvent(event)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  const label = steer ? "Steer" : "Send";
  return (
    <form
      aria-label={`Send to ${title}`}
      data-testid="project-graph-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      // Keys typed here stay out of the canvas's shortcuts.
      onKeyDown={(event) => event.stopPropagation()}
      className="menu-surface pointer-events-auto flex w-[min(560px,calc(100%-2rem))] flex-col gap-1.5 rounded-xl p-2.5 shadow-card"
    >
      <p className="truncate px-0.5 text-xs text-muted-foreground">
        {steer ? "Steer" : "Send to"} <span className="font-medium text-foreground">{title}</span>
      </p>
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={steer ? "Steer the current turn…" : "Message this session…"}
          aria-label={`Message to ${title}`}
          aria-invalid={error !== null || undefined}
          className="max-h-32 min-h-12 resize-none bg-card-solid"
        />
        <Button type="submit" size="sm" disabled={message === "" || send.isPending}>
          <SendHorizontalIcon />
          {label}
          <CompactKbd>⌘↵</CompactKbd>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="px-0.5 text-xs text-destructive">
          {error}
        </p>
      ) : (
        steer && <p className="px-0.5 text-xs text-muted-foreground">{STEER_NOTE}</p>
      )}
    </form>
  );
}
