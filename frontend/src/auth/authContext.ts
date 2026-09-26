import { createContext, useContext } from 'react';

export interface AuthUser {
  uid: string;
  email: string | null;
}

export interface AuthState {
  /** null = signed out. */
  user: AuthUser | null;
  /** true until Firebase has restored (or ruled out) a persisted session. */
  loading: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an auth provider');
  return value;
}
