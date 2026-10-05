import { Navigate, Route, Routes } from 'react-router-dom';
import { MeGate, ScopeHome, ScopeRoute } from './account/meContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { RedirectKeepingUrl } from './components/RedirectKeepingUrl';
import { ToastProvider } from './components/ui';
import { BrandHome } from './pages/brand/BrandHome';
import { ConversationsPage } from './pages/brand/ConversationsPage';
import { InsightsPage } from './pages/brand/InsightsPage';
import { NetworkPage } from './pages/brand/NetworkPage';
import { ReservationsPage } from './pages/brand/ReservationsPage';
import { SettingsPage } from './pages/brand/SettingsPage';
import { LandingPage } from './pages/landing/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlatformHome } from './pages/platform/PlatformHome';
import { RetailerHome, StoreHistory, StoreStock } from './pages/retailer/RetailerHome';
import { StoreDemand } from './pages/retailer/StoreDemand';
import { ChatPage } from './pages/shopper/ChatPage';
import { ShopPage } from './pages/shopper/ShopPage';
import { UiKitPage } from './pages/uikit/UiKitPage';
import type { FrontendProfile } from './config';

/**
 * One React app: a public landing page, three console areas (Platform, Brand, Store) and,
 * in the local profile, the demo storefront and the UI kit. The customer is never a
 * console user. Route map since UI-0 (Interface Refresh):
 *   /            public landing          /app      → the signed-in user's own console
 *   /brand/*     Brand Console           /store    Store Console (/retailer redirects)
 *   /platform    Platform Console        /shop     demo storefront (/demo-store redirects)
 *                                         /chat     the brand's chat, as the shopper sees it
 * /shop and /chat are routed in every profile (Change 16); in gcp the backend serves them
 * only with DEMO_MODE on, and the pages say "not available" otherwise.
 */
export function AppRoutes({ profile = 'local' }: { profile?: FrontendProfile }) {
  const local = profile === 'local';
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<LandingPage profile={profile} />} />
        <Route path="/login" element={<LoginPage />} />
        {/* The shopper demo (public, no login): local always; gcp only when the backend serves it. */}
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/demo-store" element={<RedirectKeepingUrl to="/shop" />} />
        {/* LOCAL PROFILE ONLY: the UI kit. */}
        {local && <Route path="/ui-kit" element={<UiKitPage />} />}
        <Route path="/retailer" element={<Navigate to="/store" replace />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<MeGate />}>
            <Route path="/app" element={<ScopeHome />} />
            <Route element={<ScopeRoute scope="PLATFORM" />}>
              <Route path="/platform" element={<PlatformHome />} />
            </Route>
            <Route element={<ScopeRoute scope="BRAND" />}>
              <Route path="/brand" element={<BrandHome />} />
              <Route path="/brand/conversations" element={<ConversationsPage autoPoll={local} />} />
              <Route path="/brand/reservations" element={<ReservationsPage />} />
              <Route path="/brand/insights" element={<InsightsPage />} />
              <Route path="/brand/outcomes" element={<Navigate to="/brand/insights" replace />} />
              <Route path="/brand/network" element={<NetworkPage />} />
              <Route path="/brand/settings" element={<SettingsPage />} />
            </Route>
            <Route element={<ScopeRoute scope="RETAIL" />}>
              <Route path="/store" element={<RetailerHome autoPoll={local} />} />
              <Route path="/store/history" element={<StoreHistory />} />
              <Route path="/store/stock" element={<StoreStock autoPoll={local} />} />
              <Route path="/store/demand" element={<StoreDemand />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ToastProvider>
  );
}
