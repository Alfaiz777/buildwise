import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'info' | 'error';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}
interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ICON = { success: CheckCircle2, info: Info, error: XCircle } as const;

/** Toasts for success and short notices. Announced politely; errors stay inline on the page. */
export function ToastProvider({ children, duration = 4500 }: { children: ReactNode; duration?: number }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = next.current++;
      setItems((all) => [...all.slice(-2), { id, tone, message }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss, duration],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toasts" aria-live="polite" aria-label="Notifications">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} className={`ui-toast ui-toast--${t.tone}`}>
              <Icon size={18} aria-hidden="true" />
              <span>{t.message}</span>
              <button type="button" className="ui-icon-button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Outside a provider (e.g. an isolated test) toasts are a no-op. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { show: () => undefined };
}
