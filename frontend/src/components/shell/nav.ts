import {
  BarChart3,
  Building2,
  CalendarCheck,
  Boxes,
  ClipboardList,
  History,
  LayoutDashboard,
  MessagesSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import type { Scope } from '../../api/apiContext';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match only this exact path (for section roots such as /brand). */
  end?: boolean;
  /** UI-3: a live count shown on the item (e.g. conversations waiting for a person). */
  badge?: 'handoffs' | 'pending';
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
    { to: '/brand/conversations', label: 'Conversations', icon: MessagesSquare, badge: 'handoffs' },
    { to: '/brand/reservations', label: 'Reservations', icon: CalendarCheck },
    { to: '/brand/insights', label: 'Insights', icon: BarChart3 },
    { to: '/brand/network', label: 'Network', icon: Network },
    { to: '/brand/settings', label: 'Settings', icon: Settings },
  ],
  RETAIL: [
    { to: '/store', label: 'Today', icon: ClipboardList, end: true, badge: 'pending' },
    { to: '/store/history', label: 'History', icon: History },
    { to: '/store/stock', label: 'Stock', icon: Boxes },
    { to: '/store/demand', label: 'Demand', icon: TrendingUp },
  ],
  PLATFORM: [
    { to: '/platform', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/platform/brands', label: 'Brands', icon: Building2 },
    { to: '/platform/network', label: 'Retail network', icon: Network },
    { to: '/platform/audit', label: 'Audit', icon: ScrollText },
    { to: '/platform/system', label: 'System', icon: Server },
  ],
};
