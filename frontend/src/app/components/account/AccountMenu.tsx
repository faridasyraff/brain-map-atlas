import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuthActions, useMe } from '@/hooks/useAuth';
import { useUi } from '@/store/ui';

/** Top-bar account controls, plus the sign-in / create-account dialog. */
export function AccountMenu() {
  const { data: user } = useMe();
  const { signOut } = useAuthActions();
  const openSignIn = useUi((s) => s.openSignIn);

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="max-w-48 truncate text-sm text-muted-foreground max-lg:hidden" title={user.email}>
          {user.email}
        </span>
        {user.is_admin && <span className="rounded-full border border-border-strong px-2 text-[11px] text-muted-foreground">Admin</span>}
        <Button variant="ghost" size="sm" onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => openSignIn('signin')}>
        Sign in
      </Button>
      <Button variant="secondary" size="sm" onClick={() => openSignIn('signup')}>
        Create account
      </Button>
    </div>
  );
}

/** The sign-in dialog. Rendered once; opened from anywhere via useUi().openSignIn. */
export function SignInDialog() {
  const mode = useUi((s) => s.signInMode);
  const close = useUi((s) => s.closeSignIn);
  const openSignIn = useUi((s) => s.openSignIn);
  const { signIn, signUp } = useAuthActions();
  const action = mode === 'signup' ? signUp : signIn;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    action.mutate({ email: email.trim(), password }, { onSuccess: () => { setPassword(''); close(); } });
  }

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => { if (!o) { close(); action.reset(); } }}>
      <DialogContent>
        <DialogTitle>{mode === 'signup' ? 'Create an account' : 'Sign in'}</DialogTitle>
        <DialogDescription>Save regions, keep private notes on them, and see what you viewed recently.</DialogDescription>
        <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
          <div>
            <label htmlFor="auth-email" className="mb-1 block text-xs font-medium text-muted-foreground">
              Email
            </label>
            <Input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="auth-password" className="mb-1 block text-xs font-medium text-muted-foreground">
              Password
            </label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'signup' && <p className="mt-1 text-xs text-subtle-foreground">At least 8 characters.</p>}
          </div>
          {action.error && (
            <p role="alert" className="text-sm text-destructive">
              {action.error.message}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={action.isPending} className="mt-1">
            {action.isPending ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {mode === 'signup' ? 'Already have an account? ' : 'Need an account? '}
            <button
              type="button"
              className="text-link hover:underline"
              onClick={() => { action.reset(); openSignIn(mode === 'signup' ? 'signin' : 'signup'); }}
            >
              {mode === 'signup' ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
