import type { ReactNode } from 'react';

/**
 * One number with its meaning. `estimated` adds "est." (values derived, e.g. quantity ×
 * price); `synthetic` says the number includes generated demo history.
 */
export function KpiTile({
  label,
  value,
  sub,
  icon,
  estimated = false,
  synthetic = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  estimated?: boolean;
  synthetic?: boolean;
}) {
  return (
    <div className="ui-kpi">
      <div className="ui-kpi__label">
        {icon && <span aria-hidden="true">{icon}</span>}
        {label}
      </div>
      <div className="ui-kpi__value">
        {value}
        {estimated && <span className="ui-kpi__est">est.</span>}
      </div>
      {(sub || synthetic) && (
        <div className="ui-kpi__sub">
          {sub}
          {synthetic && <span className="ui-pill ui-pill--neutral ui-pill--xs">Includes synthetic history</span>}
        </div>
      )}
    </div>
  );
}
