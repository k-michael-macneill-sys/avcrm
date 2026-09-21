import * as React from 'react';
import type { PublicUser } from '../../../src/types/models';
import * as api from '@/lib/api';

interface AuthContextValue {
  user: PublicUser | null;
  isCorporate: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Called from anywhere a 401 surfaces, to bounce back to the login screen. */
  handleUnauthenticated: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [user, setUser] = React.useState<PublicUser | null>(() => api.currentUser());

  const signIn = React.useCallback(async (email: string, password: string) => {
    const session = await api.signIn(email, password);
    setUser(session.user);
  }, []);

  const signOut = React.useCallback(() => {
    api.signOut();
    setUser(null);
  }, []);

  // Same effect as signOut, but named for where it is triggered from: a 401
  // partway through a screen, not a click on "Sign out".
  const handleUnauthenticated = signOut;

  const value = React.useMemo(
    () => ({
      user,
      isCorporate: user?.role === 'corporate',
      signIn,
      signOut,
      handleUnauthenticated,
    }),
    [user, signIn, signOut, handleUnauthenticated],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
