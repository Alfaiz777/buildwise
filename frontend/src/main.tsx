import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiContext } from './api/apiContext';
import { createApiClient } from './api/client';
import { AppRoutes } from './AppRoutes';
import { FirebaseAuthProvider } from './auth/FirebaseAuthProvider';
import { readConfig } from './config';
import { initFirebaseAuth } from './lib/firebase';
import './styles/tokens.css';
import './styles/base.css';
import './styles.css';
import './components/ui/ui.css';
import './components/shell/shell.css';
import './pages/landing/landing.css';
import './pages/uikit/uikit.css';
import './components/chat/chat.css';
import './pages/shopper/shop.css';

const config = readConfig(import.meta.env);
const auth = initFirebaseAuth(config);

const api = createApiClient({
  baseUrl: config.apiBaseUrl,
  // Firebase caches the ID token and refreshes it before it expires (~1 hour).
  getIdToken: async (forceRefresh) => (auth.currentUser ? auth.currentUser.getIdToken(forceRefresh) : null),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FirebaseAuthProvider auth={auth}>
      <ApiContext.Provider value={api}>
        <BrowserRouter>
          <AppRoutes profile={config.profile} />
        </BrowserRouter>
      </ApiContext.Provider>
    </FirebaseAuthProvider>
  </StrictMode>,
);
