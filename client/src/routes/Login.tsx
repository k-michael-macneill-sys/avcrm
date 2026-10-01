import * as React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SIGN_IN_CHOICES, type SignInChoice } from '../../../src/types/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthContext';
import { ApiError } from '@/lib/api';
import { ThemeToggle } from '@/theme/ThemeToggle';
import logo from '@/assets/drift-logo.jpg';

/** The last choice on this device, so a branch's tablet opens on its own branch. */
const LAST_CHOICE_KEY = 'avcrm.signInChoice';

function lastChoice(): SignInChoice | '' {
  try {
    const stored = localStorage.getItem(LAST_CHOICE_KEY);
    return SIGN_IN_CHOICES.find((c) => c === stored) ?? '';
  } catch {
    return '';
  }
}

/**
 * Sign in by branch: pick Cranbrook, Kingston, Alberta or Regina and enter
 * the branch password, or pick ADMIN and enter a corporate account's own
 * password. No email: the branch is who you are.
 */
export function Login(): JSX.Element {
  const { user, signIn } = useAuth();
  const location = useLocation();
  const [choice, setChoice] = React.useState<SignInChoice | ''>(lastChoice);
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);

  if (user) {
    const from = (location.state as { from?: Location } | null)?.from;
    return <Navigate to={from ? `${from.pathname}${from.search}` : '/'} replace />;
  }

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!choice) {
      setError('Choose your branch first');
      return;
    }
    setError('');
    setPending(true);
    signIn(choice, password)
      .then(() => {
        try {
          localStorage.setItem(LAST_CHOICE_KEY, choice);
        } catch {
          // Remembering the branch is a convenience; signing in worked.
        }
      })
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
          <label htmlFor="branch" className="mt-2 text-xs text-muted-foreground">
            Branch
          </label>
          <Select
            value={choice}
            onValueChange={(v) => {
              setChoice(v as SignInChoice);
              setError('');
            }}
          >
            <SelectTrigger id="branch">
              <SelectValue placeholder="Choose your branch" />
            </SelectTrigger>
            <SelectContent>
              {SIGN_IN_CHOICES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

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
      </div>
    </div>
  );
}
