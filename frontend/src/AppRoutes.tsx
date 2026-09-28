import { Route, Routes } from 'react-router-dom';
import { MeGate, ScopeHome, ScopeRoute } from './account/meContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { BrandHome } from './pages/brand/BrandHome';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlatformHome } from './pages/platform/PlatformHome';
import { RetailerHome } from './pages/retailer/RetailerHome';

/**
 * One React app, three console areas. The customer is never a console user:
 * the Customer AI Channel (simulator, contextual pages) arrives in M6/M8.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<MeGate />}>
          <Route path="/" element={<ScopeHome />} />
          <Route element={<ScopeRoute scope="PLATFORM" />}>
            <Route path="/platform" element={<PlatformHome />} />
          </Route>
          <Route element={<ScopeRoute scope="BRAND" />}>
            <Route path="/brand" element={<BrandHome />} />
          </Route>
          <Route element={<ScopeRoute scope="RETAIL" />}>
            <Route path="/retailer" element={<RetailerHome />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
