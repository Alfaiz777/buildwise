import { Navigate, Route, Routes } from 'react-router-dom';
import { MeGate, ScopeHome, ScopeRoute } from './account/meContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { ToastProvider } from './components/ui';
import { BrandHome } from './pages/brand/BrandHome';
import { ConversationsPage } from './pages/brand/ConversationsPage';
import { InsightsPage } from './pages/brand/InsightsPage';
import { NetworkPage } from './pages/brand/NetworkPage';
import { ReservationsPage } from './pages/brand/ReservationsPage';
import { SalesPage } from './pages/brand/SalesPage';
import { SettingsPage } from './pages/brand/SettingsPage';
import { LandingPage } from './pages/landing/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlatformBrands } from './pages/platform/PlatformBrands';
import { PlatformHome } from './pages/platform/PlatformHome';
import { PlatformAudit, PlatformNetwork, PlatformSystem } from './pages/platform/PlatformPages';
import { RetailerHome, StoreHistory, StoreStock } from './pages/retailer/RetailerHome';
import { StoreSales } from './pages/retailer/StoreSales';
import { StoreDemand } from './pages/retailer/StoreDemand';
import { UiKitPage } from './pages/uikit/UiKitPage';
import type { FrontendProfile } from './config';

/**
 * One React app: a public landing page, three console areas (Platform, Brand, Store) and, in
 * the local profile, the UI kit. The customer is never a console user: shoppers use the brand's
 * real Shopify store and WhatsApp. Route map since UI-0 (Interface Refresh):
 *   /            public landing          /app      → the signed-in user's own console
 *   /brand/*     Brand Console           /store    Store Console (/retailer redirects)
 *   /platform    Platform Console
 * The shopper demo (/shop, /chat, /demo-store) was removed for the Shopify flow; old links land
 * on the landing page.
 */
export function AppRoutes({ profile = 'local' }: { profile?: FrontendProfile }) {
  const local = profile === 'local';
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<LandingPage profile={profile} />} />
        <Route path="/login" element={<LoginPage />} />
        {/* The shopper demo was removed (the journey runs on the brand's real Shopify store). */}
        <Route path="/shop" element={<Navigate to="/" replace />} />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/demo-store" element={<Navigate to="/" replace />} />
        {/* LOCAL PROFILE ONLY: the UI kit. */}
        {local && <Route path="/ui-kit" element={<UiKitPage />} />}
        <Route path="/retailer" element={<Navigate to="/store" replace />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<MeGate />}>
            <Route path="/app" element={<ScopeHome />} />
            <Route element={<ScopeRoute scope="PLATFORM" />}>
              <Route path="/platform" element={<PlatformHome />} />
              <Route path="/platform/brands" element={<PlatformBrands />} />
              <Route path="/platform/network" element={<PlatformNetwork />} />
              <Route path="/platform/audit" element={<PlatformAudit />} />
              <Route path="/platform/system" element={<PlatformSystem />} />
            </Route>
            <Route element={<ScopeRoute scope="BRAND" />}>
              <Route path="/brand" element={<BrandHome />} />
              <Route path="/brand/conversations" element={<ConversationsPage autoPoll={local} />} />
              <Route path="/brand/reservations" element={<ReservationsPage />} />
              <Route path="/brand/sales" element={<SalesPage />} />
              <Route path="/brand/insights" element={<InsightsPage />} />
              <Route path="/brand/outcomes" element={<Navigate to="/brand/insights" replace />} />
              <Route path="/brand/network" element={<NetworkPage />} />
              <Route path="/brand/settings" element={<SettingsPage />} />
            </Route>
            <Route element={<ScopeRoute scope="RETAIL" />}>
              <Route path="/store" element={<RetailerHome autoPoll={local} />} />
              <Route path="/store/history" element={<StoreHistory />} />
              <Route path="/store/stock" element={<StoreStock autoPoll={local} />} />
              <Route path="/store/sales" element={<StoreSales />} />
              <Route path="/store/demand" element={<StoreDemand />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ToastProvider>
  );
}
