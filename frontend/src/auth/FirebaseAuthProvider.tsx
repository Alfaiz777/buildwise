import {
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth,
} from 'firebase/auth';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthContext, type AuthState, type AuthUser } from './authContext';

export function FirebaseAuthProvider({ auth, children }: { auth: Auth; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      onIdTokenChanged(auth, (firebaseUser) => {
        setUser(firebaseUser ? { uid: firebaseUser.uid, email: firebaseUser.email } : null);
        setLoading(false);
      }),
    [auth],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      async signIn(email, password) {
        await signInWithEmailAndPassword(auth, email, password);
      },
      async signOut() {
        await firebaseSignOut(auth);
      },
    }),
    [auth, user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
