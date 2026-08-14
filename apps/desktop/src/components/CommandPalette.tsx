import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

export interface CommandItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => `${command.group} ${command.label} ${command.hint ?? ""}`.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;

  const run = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    item.action();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); run(filtered[activeIndex]); }
  };

  let lastGroup = "";
  return (
    <div className="dialog-scrim palette-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input-row">
          <Search size={16} aria-hidden="true" />
          <input ref={inputRef} aria-label="Search commands" placeholder="Type a command or search..." value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={onKeyDown} />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" role="listbox" aria-label="Commands" aria-activedescendant={filtered[activeIndex] ? `palette-item-${filtered[activeIndex].id}` : undefined}>
          {filtered.map((item, index) => {
            const groupHeader = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <Fragment key={item.id}>
                {groupHeader}
                <button id={`palette-item-${item.id}`} className={`palette-item ${index === activeIndex ? "is-active" : ""}`} role="option" aria-selected={index === activeIndex} type="button" onMouseEnter={() => setActiveIndex(index)} onClick={() => run(item)}>
                  <span>{item.label}</span>
                  {item.hint && <kbd>{item.hint}</kbd>}
                </button>
              </Fragment>
            );
          })}
          {!filtered.length && <div className="palette-empty">No commands match &ldquo;{query}&rdquo;.</div>}
        </div>
      </div>
    </div>
  );
}
