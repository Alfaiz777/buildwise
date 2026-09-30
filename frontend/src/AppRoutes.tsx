import { Route, Routes } from 'react-router-dom';
import { MeGate, ScopeHome, ScopeRoute } from './account/meContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { BrandHome } from './pages/brand/BrandHome';
import { ConversationsPage } from './pages/brand/ConversationsPage';
import { DemoStorePage } from './pages/demo/DemoStorePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlatformHome } from './pages/platform/PlatformHome';
import { RetailerHome } from './pages/retailer/RetailerHome';
import type { FrontendProfile } from './config';

/**
 * One React app, three console areas. The customer is never a console user:
 * the Customer AI Channel (simulator) arrives in M4; contextual pages are deferred.
 */
export function AppRoutes({ profile = 'local' }: { profile?: FrontendProfile }) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* LOCAL PROFILE ONLY: the demo storefront (public, no login). Never routed in gcp. */}
      {profile === 'local' && <Route path="/demo-store" element={<DemoStorePage />} />}
      <Route element={<ProtectedRoute />}>
        <Route element={<MeGate />}>
          <Route path="/" element={<ScopeHome />} />
          <Route element={<ScopeRoute scope="PLATFORM" />}>
            <Route path="/platform" element={<PlatformHome />} />
          </Route>
          <Route element={<ScopeRoute scope="BRAND" />}>
            <Route path="/brand" element={<BrandHome />} />
            <Route path="/brand/conversations" element={<ConversationsPage autoPoll={profile === 'local'} />} />
          </Route>
          <Route element={<ScopeRoute scope="RETAIL" />}>
            <Route path="/retailer" element={<RetailerHome autoPoll={profile === 'local'} />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
