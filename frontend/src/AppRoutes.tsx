import { Navigate, Route, Routes } from 'react-router-dom';
import { MeGate, ScopeHome, ScopeRoute } from './account/meContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { RedirectKeepingUrl } from './components/RedirectKeepingUrl';
import { ToastProvider } from './components/ui';
import { BrandHome } from './pages/brand/BrandHome';
import { ConversationsPage } from './pages/brand/ConversationsPage';
import { OutcomesPage } from './pages/brand/OutcomesPage';
import { DemoStorePage } from './pages/demo/DemoStorePage';
import { LandingPage } from './pages/landing/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlatformHome } from './pages/platform/PlatformHome';
import { RetailerHome } from './pages/retailer/RetailerHome';
import { UiKitPage } from './pages/uikit/UiKitPage';
import type { FrontendProfile } from './config';

/**
 * One React app: a public landing page, three console areas (Platform, Brand, Store) and,
 * in the local profile, the demo storefront and the UI kit. The customer is never a
 * console user. Route map since UI-0 (Interface Refresh):
 *   /            public landing          /app      → the signed-in user's own console
 *   /brand/*     Brand Console           /store    Store Console (/retailer redirects)
 *   /platform    Platform Console        /shop     demo storefront (/demo-store redirects)
 */
export function AppRoutes({ profile = 'local' }: { profile?: FrontendProfile }) {
  const local = profile === 'local';
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<LandingPage profile={profile} />} />
        <Route path="/login" element={<LoginPage />} />
        {/* LOCAL PROFILE ONLY: the demo storefront and the UI kit (public, no login). Never routed in gcp. */}
        {local && <Route path="/shop" element={<DemoStorePage />} />}
        {local && <Route path="/demo-store" element={<RedirectKeepingUrl to="/shop" />} />}
        {local && <Route path="/ui-kit" element={<UiKitPage />} />}
        <Route path="/retailer" element={<Navigate to="/store" replace />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<MeGate />}>
            <Route path="/app" element={<ScopeHome />} />
            <Route element={<ScopeRoute scope="PLATFORM" />}>
              <Route path="/platform" element={<PlatformHome />} />
            </Route>
            <Route element={<ScopeRoute scope="BRAND" />}>
              <Route path="/brand" element={<BrandHome demoStorefront={local} />} />
              <Route path="/brand/conversations" element={<ConversationsPage autoPoll={local} />} />
              <Route path="/brand/outcomes" element={<OutcomesPage />} />
            </Route>
            <Route element={<ScopeRoute scope="RETAIL" />}>
              <Route path="/store" element={<RetailerHome autoPoll={local} />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ToastProvider>
  );
}
