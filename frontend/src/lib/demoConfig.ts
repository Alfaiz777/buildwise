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
  demoMode: boolean;
  logins: DemoLogin[];
}

const OFF: DemoConfigState = { demoMode: false, logins: [] };

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
      .then((body: { demo_mode?: boolean; logins?: DemoLogin[] } | null) => {
        if (cancelled || !body?.demo_mode) return;
        setState({ demoMode: true, logins: Array.isArray(body.logins) ? body.logins : [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * Profiles in which the shopper demo (/shop) is routed. Local today; UI-2 adds gcp, where
 * it is served only with DEMO_MODE on for the allowlisted demo brand.
 */
export const SHOPPER_DEMO_PROFILES: readonly FrontendProfile[] = ['local'];

export function shopperDemoAvailable(demoMode: boolean, profile: FrontendProfile): boolean {
  return demoMode && SHOPPER_DEMO_PROFILES.includes(profile);
}
