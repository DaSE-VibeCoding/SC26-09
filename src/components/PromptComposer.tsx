import { forwardRef, useId } from "react";

interface PromptComposerProps {
  readonly value: string;
  readonly agentName: string;
  readonly attention: boolean;
  readonly sending: boolean;
  readonly blocked: boolean;
  readonly readinessMessage: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
}

export const PromptComposer = forwardRef<HTMLTextAreaElement, PromptComposerProps>(function PromptComposer(
  { value, agentName, attention, sending, blocked, readinessMessage, onChange, onSend },
  ref,
) {
  const statusId = useId();
  const sendDisabled = blocked || sending || !value.trim();

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            if (!sendDisabled) onSend();
          }
        }}
        aria-label={`Prompt for ${agentName}`}
        aria-describedby={statusId}
        placeholder={attention
          ? `Reply to ${agentName}…`
          : `Give ${agentName} a task…`}
      />
      <div className="composer-footer">
        <span>⌘Enter to send · Enter for newline</span>
        <span id={statusId} className="composer-readiness" role="status" aria-live="polite">
          {readinessMessage}
        </span>
        <button type="button" onClick={onSend} disabled={sendDisabled}>{sending ? "Sending…" : "Send"}</button>
      </div>
    </div>
  );
});
