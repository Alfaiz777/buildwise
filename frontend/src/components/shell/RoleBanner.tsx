import { ArrowRight, Info, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MeResponse, Scope } from '../../api/apiContext';
import { storeLabel } from '../../lib/storeLabel';

const key = (scope: string) => `qs_role_banner_dismissed:${scope}`;

export function readDismissed(scope: string): boolean {
  try {
    return window.localStorage.getItem(key(scope)) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(scope: Scope, dismissed: boolean) {
  try {
    if (dismissed) window.localStorage.setItem(key(scope), '1');
    else window.localStorage.removeItem(key(scope));
  } catch {
    // storage blocked: the choice holds for this page view only
  }
}

/** One sentence that says who you are here and what this console is for. */
export function roleSentence(me: MeResponse): string {
  switch (me.scope) {
    case 'RETAIL':
      return `You run ${storeLabel(me.store)} for ${me.brand_name} via ${me.retailer_name}. Holds from customers arrive here.`;
    case 'BRAND':
      return `You manage ${me.brand_name}. See what Qwikspot did for your brand, steer conversations and run your store network.`;
    case 'PLATFORM':
      return 'You run the Qwikspot platform: onboard brands and watch their health. Customer data is never shown here.';
  }
}

/**
 * The welcome note: shown on the first visit to a console, dismissed per browser and console.
 * UI-P1: the shell may control it (the Platform header's "?" shows it again).
 */
export function useRoleBanner(scope: Scope) {
  const [open, setOpen] = useState(() => !readDismissed(scope));
  return {
    open,
    dismiss: () => {
      writeDismissed(scope, true);
      setOpen(false);
    },
    show: () => {
      writeDismissed(scope, false);
      setOpen(true);
    },
  };
}

export function RoleBanner({ me, open, onDismiss }: { me: MeResponse; open?: boolean; onDismiss?: () => void }) {
  const own = useRoleBanner(me.scope);
  const visible = open ?? own.open;
  const dismiss = onDismiss ?? own.dismiss;
  if (!visible) return null;
  return (
    <div className="shell-banner" role="note">
      <Info size={16} aria-hidden="true" />
      <span>
        {roleSentence(me)}
        {me.scope === 'PLATFORM' && (
          <>
            {' '}
            <Link className="shell-banner__link" to="/platform#attention">
              Start with what needs attention <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </>
        )}
      </span>
      <button type="button" className="ui-icon-button" aria-label="Dismiss this note" onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
