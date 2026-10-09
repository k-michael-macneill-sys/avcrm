import * as React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SIGN_IN_CHOICES, type SignInChoice } from '../../../src/types/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthContext';
import { ApiError, resetBranchPassword } from '@/lib/api';
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

        <ResetPassword choice={choice} />
      </div>
    </div>
  );
}

/**
 * "Reset password" for the chosen branch: a new password and the reset code.
 * The code is what stops anybody else changing a branch's password, in place
 * of a second factor.
 */
function ResetPassword({ choice }: { choice: SignInChoice | '' }): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [newPassword, setNewPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = React.useState(false);

  if (!open) {
    return (
      <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => setOpen(true)}>
        Reset password
      </Button>
    );
  }

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!choice || choice === 'ADMIN') {
      setMessage({ ok: false, text: 'Choose the branch whose password you are resetting' });
      return;
    }
    setPending(true);
    setMessage(null);
    resetBranchPassword(choice, newPassword, code)
      .then(() => {
        setMessage({ ok: true, text: `${choice}’s password is reset. Sign in with the new one.` });
        setNewPassword('');
        setCode('');
      })
      .catch((err: unknown) => {
        setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not reset the password' });
      })
      .finally(() => setPending(false));
  };

  return (
    <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-1 border-t border-border pt-4">
      <h2 className="text-sm font-semibold">Reset {choice && choice !== 'ADMIN' ? choice : 'branch'} password</h2>
      <label htmlFor="new-password" className="mt-2 text-xs text-muted-foreground">
        New password
      </label>
      <Input
        id="new-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={4}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
      />
      <label htmlFor="reset-code" className="mt-2 text-xs text-muted-foreground">
        Reset code
      </label>
      <Input
        id="reset-code"
        type="password"
        autoComplete="off"
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <p className={`min-h-[1.5em] text-sm ${message?.ok ? 'text-primary' : 'text-critical'}`} aria-live="polite">
        {message?.text}
      </p>
      <div className="mt-1 flex gap-2">
        <Button type="button" variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} className="flex-1">
          {pending ? 'Resetting…' : 'Reset password'}
        </Button>
      </div>
    </form>
  );
}
