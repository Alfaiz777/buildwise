import { useEffect, useState } from 'react';

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
}

const OFF: DemoConfigState = { loaded: false, demoMode: false, logins: [] };

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
        if (cancelled) return;
        setState({
          loaded: true,
          demoMode: body?.demo_mode === true,
          logins: body?.demo_mode && Array.isArray(body.logins) ? body.logins : [],
        });
      })
      .catch(() => !cancelled && setState({ ...OFF, loaded: true }));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
