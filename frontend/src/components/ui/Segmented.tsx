/**
 * A compact segmented control (UI-P1): two to four mutually exclusive choices as one pill
 * group — "7 days | 28 days", "Live only | Live + demo history". Each choice is a toggle
 * button (aria-pressed), so it reads and works like the buttons it replaces.
 */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  /** The group's accessible name ("Period", "History"). */
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="ui-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className="ui-segmented__option"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
