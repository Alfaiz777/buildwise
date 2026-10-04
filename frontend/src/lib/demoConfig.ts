import { useEffect, useState } from 'react';
import type { FrontendProfile } from '../config';

export interface DemoLogin {
  email: string;
  password: string;
  role: string;
  title: string;
  hint: string;
}

export interface DemoConfigState {
  /** False until the config answered (or failed). */
  loaded: boolean;
  demoMode: boolean;
  logins: DemoLogin[];
  /** The brand the shopper demo (/shop, /chat) opens, when it exists here (Change 16). */
  shopperDemoBrand: string | null;
}

const OFF: DemoConfigState = { loaded: false, demoMode: false, logins: [], shopperDemoBrand: null };

/**
 * GET /api/demo/config (public; Change 14, G3). Demo logins reach the browser only here,
 * at runtime and only with DEMO_MODE on — never in the bundle. Any failure reads as "off".
 */
export function useDemoConfig(): DemoConfigState {
  const [state, setState] = useState<DemoConfigState>(OFF);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/demo/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { demo_mode?: boolean; logins?: DemoLogin[]; shopper_demo?: { brand_id?: string } } | null) => {
        if (cancelled) return;
        setState({
          loaded: true,
          demoMode: body?.demo_mode === true,
          logins: body?.demo_mode && Array.isArray(body.logins) ? body.logins : [],
          shopperDemoBrand: typeof body?.shopper_demo?.brand_id === 'string' ? body.shopper_demo.brand_id : null,
        });
      })
      .catch(() => !cancelled && setState({ ...OFF, loaded: true }));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * Profiles in which /shop and /chat are routed (Change 16): both. In gcp the backend
 * serves the shopper demo only with DEMO_MODE on, for the allowlisted demo brand; the page
 * shows "not available" otherwise.
 */
export const SHOPPER_DEMO_PROFILES: readonly FrontendProfile[] = ['local', 'gcp'];

export function shopperDemoAvailable(demo: DemoConfigState, profile: FrontendProfile): boolean {
  return demo.demoMode && demo.shopperDemoBrand !== null && SHOPPER_DEMO_PROFILES.includes(profile);
}
