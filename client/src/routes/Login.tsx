import * as React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/auth/AuthContext';
import { ApiError } from '@/lib/api';
import { ThemeToggle } from '@/theme/ThemeToggle';
import logo from '@/assets/drift-logo.jpg';

const SEED_ACCOUNT: [string, string] = ['corporate@avcrm.test', 'Corporate — add the first branch and crew from here'];

/**
 * The one account a fresh install has is listed because this is a
 * development build and guessing it from the README while looking at a
 * login box is nobody's idea of a good time. Everything else — branches,
 * crew, customers — is added through the app after this first sign-in.
 */
export function Login(): JSX.Element {
  const { user, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = React.useState('corporate@avcrm.test');
  const [password, setPassword] = React.useState('Password123!');
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);

  if (user) {
    const from = (location.state as { from?: Location } | null)?.from;
    return <Navigate to={from ? `${from.pathname}${from.search}` : '/'} replace />;
  }

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    setError('');
    setPending(true);
    signIn(email.trim(), password)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not sign in');
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="glass-card w-full max-w-sm rounded-2xl border border-border bg-card/60 p-7 shadow-2xl backdrop-blur-xl">
        <img src={logo} alt="Drift Property Services" className="mb-3 h-12 w-auto rounded-md" />
        <h1 className="mb-4 mt-1 text-2xl font-semibold tracking-tight">Sign in</h1>

        <form onSubmit={onSubmit} className="flex flex-col gap-1">
          <label htmlFor="email" className="mt-2 text-xs text-muted-foreground">
            Email
          </label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label htmlFor="password" className="mt-2 text-xs text-muted-foreground">
            Password
          </label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <p className="min-h-[1.5em] text-sm text-critical" aria-live="polite">
            {error}
          </p>

          <Button type="submit" disabled={pending} className="mt-3">
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <div className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
          <p>Seeded account:</p>
          <ul className="mt-1.5 list-none space-y-1 pl-0">
            <li>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  setEmail(SEED_ACCOUNT[0]);
                  setPassword('Password123!');
                }}
              >
                {SEED_ACCOUNT[0]}
              </button>{' '}
              — {SEED_ACCOUNT[1]}
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
