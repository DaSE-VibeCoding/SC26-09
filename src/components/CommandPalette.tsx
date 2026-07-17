import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  icon?: IconName;
  disabled?: boolean;
  run(): void;
}

interface CommandPaletteProps {
  open: boolean;
  actions: PaletteAction[];
  onClose(): void;
}

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return value
      ? actions.filter((action) => `${action.label} ${action.detail ?? ""}`.toLowerCase().includes(value))
      : actions;
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    queueMicrotask(() => inputRef.current?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "input:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener("keydown", trapFocus);
    return () => {
      dialog?.removeEventListener("keydown", trapFocus);
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [open]);

  useEffect(() => {
    const firstEnabled = filtered.findIndex((action) => !action.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [filtered]);

  const moveSelection = (direction: -1 | 1) => {
    const enabled = filtered
      .map((action, index) => action.disabled ? -1 : index)
      .filter((index) => index >= 0);
    if (enabled.length === 0) return;
    const currentPosition = enabled.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? direction > 0 ? 0 : enabled.length - 1
      : (currentPosition + direction + enabled.length) % enabled.length;
    setActiveIndex(enabled[nextPosition]);
  };

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input-row">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={filtered[activeIndex] ? `palette-action-${filtered[activeIndex].id}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              }
              const selected = filtered[activeIndex];
              if (event.key === "Enter" && selected && !selected.disabled) {
                event.preventDefault();
                selected.run();
                onClose();
              }
            }}
            placeholder="Search actions…"
          />
        </div>
        <div id="palette-results" className="palette-results" role="listbox" aria-label="Commands">
          {filtered.map((action, index) => (
            <button
              type="button"
              key={action.id}
              id={`palette-action-${action.id}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "is-active" : ""}
              disabled={action.disabled}
              onMouseEnter={() => {
                if (!action.disabled) setActiveIndex(index);
              }}
              onClick={() => {
                action.run();
                onClose();
              }}
            >
              {action.icon && <Icon name={action.icon} size={16} />}
              <span><strong>{action.label}</strong>{action.detail && <small>{action.detail}</small>}</span>
              {action.shortcut && <kbd>{action.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <p className="palette-empty">No matching command</p>}
        </div>
      </section>
    </div>
  );
}
