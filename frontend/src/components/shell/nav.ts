import { BarChart3, Building2, ClipboardList, LayoutDashboard, MessagesSquare, type LucideIcon } from 'lucide-react';
import type { Scope } from '../../api/apiContext';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match only this exact path (for section roots such as /brand). */
  end?: boolean;
}

export const CONSOLE_NAME: Record<Scope, string> = {
  PLATFORM: 'Platform Console',
  BRAND: 'Brand Console',
  RETAIL: 'Store Console',
};

/** One list per console. Later phases add their pages here (UI-3 … UI-5). */
export const NAV: Record<Scope, NavItem[]> = {
  BRAND: [
    { to: '/brand', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/brand/conversations', label: 'Conversations', icon: MessagesSquare },
    { to: '/brand/outcomes', label: 'Insights', icon: BarChart3 },
  ],
  RETAIL: [{ to: '/store', label: 'Today', icon: ClipboardList, end: true }],
  PLATFORM: [{ to: '/platform', label: 'Overview', icon: Building2, end: true }],
};
