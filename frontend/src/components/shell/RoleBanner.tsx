import { Info, X } from 'lucide-react';
import { useState } from 'react';
import type { MeResponse } from '../../api/apiContext';

const key = (scope: string) => `qs_role_banner_dismissed:${scope}`;

function readDismissed(scope: string): boolean {
  try {
    return window.localStorage.getItem(key(scope)) === '1';
  } catch {
    return false;
  }
}

/** One sentence that says who you are here and what this console is for. */
export function roleSentence(me: MeResponse): string {
  switch (me.scope) {
    case 'RETAIL':
      return `You run ${me.store.store_name} for ${me.brand_name} via ${me.retailer_name}. Holds from customers arrive here.`;
    case 'BRAND':
      return `You manage ${me.brand_name}. See what Qwikspot did for your brand, steer conversations and run your store network.`;
    case 'PLATFORM':
      return 'You run the Qwikspot platform: onboard brands and watch their health. Customer data is never shown here.';
  }
}

/** Shown on the first visit to a console; dismissed per browser and console. */
export function RoleBanner({ me }: { me: MeResponse }) {
  const [hidden, setHidden] = useState(() => readDismissed(me.scope));
  if (hidden) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(key(me.scope), '1');
    } catch {
      // storage blocked: hide for this page view only
    }
    setHidden(true);
  };
  return (
    <div className="shell-banner" role="note">
      <Info size={16} aria-hidden="true" />
      <span>{roleSentence(me)}</span>
      <button type="button" className="ui-icon-button" aria-label="Dismiss this note" onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
