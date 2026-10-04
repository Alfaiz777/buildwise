import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useAuth } from '../../auth/authContext';
import { label } from '../../lib/labels';
import { Wordmark } from './Wordmark';
import { CONSOLE_NAME, NAV } from './nav';
import { RoleBanner } from './RoleBanner';

/**
 * The frame of every console (UI-0): header, left sidebar on desktop, bottom tab bar on
 * phones, a role accent and the first-visit role banner. Scope comes from /api/me only.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const { signOut } = useAuth();
  const context =
    me.scope === 'RETAIL'
      ? `${me.store.store_name} · ${me.brand_name}`
      : me.scope === 'BRAND'
        ? me.brand_name
        : 'Qwikspot platform';
  const nav = NAV[me.scope];

  return (
    <div className={`shell shell--${me.scope.toLowerCase()}`}>
      <header className="shell-top">
        <div className="shell-top__brand">
          <Wordmark />
          <span className="shell-top__console">{CONSOLE_NAME[me.scope]}</span>
          <span className="shell-top__context">{context}</span>
        </div>
        <div className="shell-top__user">
          <span className="shell-top__email">{me.user.email ?? me.user.user_id}</span>
          <span className="ui-pill ui-pill--primary shell-role">{label(me.role)}</span>
          <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>
      <nav className="shell-nav" aria-label={CONSOLE_NAME[me.scope]}>
        <ul>
          {nav.map(({ to, label: text, icon: Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className="shell-nav__link">
                <Icon size={18} aria-hidden="true" />
                <span>{text}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="shell-body">
        <RoleBanner me={me} />
        <main className="shell-main">{children}</main>
      </div>
    </div>
  );
}
