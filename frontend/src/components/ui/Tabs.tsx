import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number;
}

/**
 * ARIA tabs (manual activation): Left/Right/Home/End move focus and select. The panel is
 * rendered by the caller with `tabPanelProps(id)`.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % items.length
        : e.key === 'ArrowLeft'
          ? (index - 1 + items.length) % items.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next]!.id);
  };
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${base}-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`${base}-${t.id}-panel`}
          tabIndex={t.id === value ? 0 : -1}
          className="ui-tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count !== undefined && <span className="ui-tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
