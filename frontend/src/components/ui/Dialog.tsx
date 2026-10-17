import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';

/** Keeps Tab inside `root`, closes on Escape and returns focus to where it was. */
function useModal(open: boolean, onClose: () => void) {
  const root = useRef<HTMLDivElement>(null);
  // The latest onClose, so a new callback each render does not re-run the effect (which would
  // move focus back to the first field while the user types).
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        root.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    (focusables()[0] ?? root.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open]);
  return root;
}

/** Asks before something that can't be undone or affects others. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  /** UI-P1: e.g. until a required reason is filled in. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const root = useModal(open, onCancel);
  if (!open) return null;
  return (
    <div className="ui-overlay" onClick={onCancel}>
      <div
        ref={root}
        className="ui-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`${id}-title`} className="ui-dialog__title">
          {title}
        </h2>
        <div id={`${id}-body`} className="ui-dialog__body">
          {children}
        </div>
        <div className="ui-dialog__actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={busy} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A side panel (from the right on desktop, the bottom on phones). */
export function Drawer({
  open,
  title,
  icon,
  flush = false,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  /** UI-P1: the body fills the drawer without padding or its own scroll (a chat lays itself out). */
  flush?: boolean;
  /** UI-P1: a mark before the title (e.g. the Ask Qwikspot logo). */
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const id = useId();
  const root = useModal(open, onClose);
  if (!open) return null;
  return (
    <div className="ui-overlay ui-overlay--drawer" onClick={onClose}>
      <div
        ref={root}
        className="ui-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ui-drawer__header">
          <h2 id={`${id}-title`} className="ui-drawer__title">
            {icon}
            {title}
          </h2>
          <button type="button" className="ui-icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className={`ui-drawer__body${flush ? ' ui-drawer__body--flush' : ''}`}>{children}</div>
      </div>
    </div>
  );
}
