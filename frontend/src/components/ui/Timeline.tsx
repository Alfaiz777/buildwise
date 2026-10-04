import type { ReactNode } from 'react';
import type { Tone } from './Badge';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  time?: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}

/** A vertical sequence of what happened, oldest first. */
export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol className="ui-timeline" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className={`ui-timeline__item ui-timeline__item--${item.tone ?? 'neutral'}`}>
          <span className="ui-timeline__dot" aria-hidden="true">
            {item.icon}
          </span>
          <div className="ui-timeline__content">
            <div className="ui-timeline__title">
              {item.title}
              {item.time && <time className="ui-timeline__time">{item.time}</time>}
            </div>
            {item.detail && <div className="ui-timeline__detail">{item.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
