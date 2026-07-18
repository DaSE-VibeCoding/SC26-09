import { useMemo, useState } from "react";
import type { FirstClassAgentId } from "../agents/types";
import { getAgentAdapter } from "../agents/registry";
import type { AgentInstallation, AgentSession, Workspace } from "../domain/models";
import {
  MAX_HANDOFF_SOURCE_SESSIONS,
  createSessionHandoffExportRequest,
  selectHandoffSourceSessions,
  selectHandoffTargetAgents,
  type SessionHandoffExportRequest,
  type SessionHandoffExportResponse,
} from "../domain/sessionHandoff";
import { AgentLogo } from "./AgentLogo";

export interface SessionHandoffDialogProps {
  workspace: Workspace;
  sessions: readonly AgentSession[];
  installations: readonly AgentInstallation[];
  generateExport(request: SessionHandoffExportRequest): Promise<SessionHandoffExportResponse>;
  onStart(targetAgentId: FirstClassAgentId, editedMarkdown: string): void;
  onCancel(): void;
}

type HandoffStep = "sources" | "target" | "review";

export function SessionHandoffDialog({
  workspace,
  sessions,
  installations,
  generateExport,
  onStart,
  onCancel,
}: SessionHandoffDialogProps) {
  const eligibleSources = useMemo(
    () => selectHandoffSourceSessions(sessions, workspace.id),
    [sessions, workspace.id],
  );
  const [step, setStep] = useState<HandoffStep>("sources");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<FirstClassAgentId | null>(null);
  const [generated, setGenerated] = useState<SessionHandoffExportResponse | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationFailed, setGenerationFailed] = useState(false);
  const selectedSources = eligibleSources.filter((session) => selectedIds.includes(session.id));
  const targetAgents = selectHandoffTargetAgents(installations, selectedSources);

  const generate = async () => {
    if (!targetAgentId || !targetAgents.includes(targetAgentId)) return;
    setGenerating(true);
    setGenerationFailed(false);
    try {
      const result = await generateExport(createSessionHandoffExportRequest(workspace, selectedSources));
      setGenerated(result);
      setMarkdown(result.markdown);
      setStep("review");
    } catch {
      // Backend errors can contain private paths or handles; keep the rendered error generic.
      setGenerationFailed(true);
    } finally {
      setGenerating(false);
    }
  };

  const backToSources = () => {
    setTargetAgentId(null);
    setGenerated(null);
    setMarkdown("");
    setGenerationFailed(false);
    setStep("sources");
  };

  return (
    <div className="session-handoff-backdrop">
      <section className="session-handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="session-handoff-title">
        <header className="session-handoff-header">
          <p className="session-handoff-eyebrow">Cross-agent handoff · Step {step === "sources" ? 1 : step === "target" ? 2 : 3} of 3</p>
          <h2 id="session-handoff-title">Continue work with another agent</h2>
          <p>Pelican creates an editable Markdown briefing. It does not launch an agent or send anything automatically.</p>
        </header>

        {step === "sources" && (
          <div className="session-handoff-step session-handoff-sources">
            <fieldset>
              <legend>Select 1–{MAX_HANDOFF_SOURCE_SESSIONS} saved sessions</legend>
              {eligibleSources.map((session, index) => {
                const checked = selectedIds.includes(session.id);
                const adapter = getAgentAdapter(session.agentId);
                return (
                  <label className="session-handoff-option" key={session.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selectedIds.length >= MAX_HANDOFF_SOURCE_SESSIONS}
                      data-dialog-initial-focus={index === 0 ? "true" : undefined}
                      onChange={() => {
                        setSelectedIds((current) => checked
                          ? current.filter((id) => id !== session.id)
                          : [...current, session.id]);
                      }}
                    />
                    <AgentLogo agentId={session.agentId} size={28} />
                    <span><strong>{session.title}</strong><small>{adapter.displayName} · Saved session</small></span>
                  </label>
                );
              })}
              {eligibleSources.length === 0 && <p className="session-handoff-empty">No eligible saved sessions in this workspace.</p>}
            </fieldset>
          </div>
        )}

        {step === "target" && (
          <div className="session-handoff-step session-handoff-targets">
            <fieldset>
              <legend>Choose an installed target agent</legend>
              {targetAgents.map((agentId, index) => {
                const adapter = getAgentAdapter(agentId);
                return (
                  <label className="session-handoff-option" key={agentId}>
                    <input type="radio" name="handoff-target" checked={targetAgentId === agentId}
                      data-dialog-initial-focus={index === 0 ? "true" : undefined}
                      onChange={() => setTargetAgentId(agentId)} />
                    <AgentLogo agentId={agentId} size={28} />
                    <span><strong>{adapter.displayName}</strong><small>{adapter.description}</small></span>
                  </label>
                );
              })}
              {targetAgents.length === 0 && <p className="session-handoff-empty">No different installed agent is available for this selection.</p>}
            </fieldset>
            {generationFailed && <p className="session-handoff-error" role="alert">The handoff could not be generated. Try again.</p>}
          </div>
        )}

        {step === "review" && generated && targetAgentId && (
          <div className="session-handoff-step session-handoff-review">
            <div className="session-handoff-target-summary">
              <AgentLogo agentId={targetAgentId} size={28} />
              <span>Review briefing for <strong>{getAgentAdapter(targetAgentId).displayName}</strong></span>
            </div>
            {generated.truncated && <p className="session-handoff-warning" role="status">Some session content was truncated to keep the handoff within export limits.</p>}
            {generated.warnings.length > 0 && (
              <div className="session-handoff-warnings" aria-label="Export warnings">
                <strong>Review these warnings</strong>
                <ul>{generated.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              </div>
            )}
            <label className="session-handoff-editor">
              <span>Markdown briefing</span>
              <textarea data-dialog-initial-focus="true" value={markdown} onChange={(event) => setMarkdown(event.target.value)} rows={16} />
            </label>
          </div>
        )}

        <aside className="session-handoff-privacy">
          <strong>Privacy reminder</strong>
          <span>The export contains visible user and assistant text only, but that text may include code or secrets you pasted. Tool data, hidden reasoning, and provider metadata are excluded. Review it before starting.</span>
        </aside>

        <footer className="session-handoff-actions">
          <button type="button" className="session-handoff-cancel" onClick={onCancel}>Cancel</button>
          {step === "target" && <button type="button" className="session-handoff-back" onClick={backToSources}>Back</button>}
          {step === "review" && <button type="button" className="session-handoff-back" onClick={() => setStep("target")}>Back</button>}
          {step === "sources" && <button type="button" className="session-handoff-primary" disabled={selectedSources.length === 0} onClick={() => setStep("target")}>Choose target</button>}
          {step === "target" && <button type="button" className="session-handoff-primary" disabled={!targetAgentId || generating} onClick={() => void generate()}>{generating ? "Generating…" : generationFailed ? "Try again" : "Generate briefing"}</button>}
          {step === "review" && <button type="button" className="session-handoff-regenerate" disabled={generating} onClick={() => void generate()}>Regenerate</button>}
          {step === "review" && <button type="button" className="session-handoff-primary" disabled={!markdown.trim()} onClick={() => onStart(targetAgentId!, markdown)}>Start with briefing</button>}
        </footer>
      </section>
    </div>
  );
}
