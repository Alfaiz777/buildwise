import { useId, type ReactNode } from 'react';

/** A surface with an optional header (title, description, actions); a titled card is a region named by its title. */
export function Card({
  title,
  description,
  actions,
  children,
  id,
  className,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
  padded?: boolean;
}) {
  const titleId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? titleId : undefined}
      className={['ui-card', padded ? 'ui-card--padded' : '', className].filter(Boolean).join(' ')}
    >
      {(title || actions) && (
        <header className="ui-card__header">
          <div>
            {title && (
              <h2 id={titleId} className="ui-card__title">
                {title}
              </h2>
            )}
            {description && <p className="ui-card__description">{description}</p>}
          </div>
          {actions && <div className="ui-card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
