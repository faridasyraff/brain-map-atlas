import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthActions } from '@/hooks/useAuth';
import { itemKey, useLibrary } from '@/hooks/useLibrary';
import type { LibraryItem } from '@/lib/api';
import { openRegionRef } from '@/lib/navigate';
import { isHexColor } from '@/lib/selection';
import { useUi } from '@/store/ui';

/** Saved regions (with note previews), recently viewed, and account deletion. */
export function SavedPanel() {
  const lib = useLibrary();
  const openSignIn = useUi((s) => s.openSignIn);

  if (!lib.signedIn) {
    return (
      <div className="p-5">
        <h2 className="text-sm font-semibold">Keep regions you care about</h2>
        <p className="mt-1 max-w-[48ch] text-sm text-muted-foreground">
          Sign in to save regions, add private notes to them, and see what you viewed recently.
        </p>
        <Button variant="primary" size="sm" className="mt-4" onClick={() => openSignIn('signin')}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div>
      <section className="border-b border-border p-5">
        <h2 className="mb-3 text-sm font-semibold">Saved regions</h2>
        {lib.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : lib.saved.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing saved yet. Use Save in the inspector to keep a region here.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {lib.saved.map((it) => (
              <Row key={itemKey(it)} item={it} note={it.note} onRemove={() => lib.unsave.mutate(it)} />
            ))}
          </ul>
        )}
      </section>
      <section className="border-b border-border p-5">
        <h2 className="mb-3 text-sm font-semibold">Recently viewed</h2>
        {lib.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Regions you open will appear here.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {lib.history.slice(0, 15).map((it) => (
              <Row key={`${itemKey(it)}-${it.viewed_at}`} item={it} />
            ))}
          </ul>
        )}
      </section>
      <DeleteAccount />
    </div>
  );
}

function Row({ item, note, onRemove }: { item: LibraryItem; note?: string; onRemove?: () => void }) {
  return (
    <li className="group flex items-center gap-1 rounded-sm hover:bg-hover">
      <button type="button" onClick={() => void openRegionRef(item)} className="flex min-w-0 flex-1 items-start gap-2 p-2 text-left">
        <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-[2px]" style={{ background: isHexColor(item.color) ? item.color : 'var(--color-border-strong)' }} />
        <span className="min-w-0">
          <span className="text-sm">{item.label}</span>
          {item.acronym && <span className="ml-2 text-xs text-subtle-foreground">{item.acronym}</span>}
          {item.kind === 'group' && <span className="ml-2 text-xs text-subtle-foreground">Group</span>}
          {note && <span className="block truncate text-xs text-muted-foreground">{note}</span>}
        </span>
      </button>
      {onRemove && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${item.label} from saved regions`}
          onClick={onRemove}
          className="shrink-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
        >
          Remove
        </Button>
      )}
    </li>
  );
}

function DeleteAccount() {
  const { deleteAccount } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');

  if (!open) {
    return (
      <div className="p-5">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Delete account…
        </Button>
      </div>
    );
  }
  return (
    <form
      className="p-5"
      onSubmit={(e) => {
        e.preventDefault();
        deleteAccount.mutate(password, { onSuccess: () => toast.success('Your account and everything saved with it were deleted.') });
      }}
    >
      <p className="max-w-[48ch] text-sm text-muted-foreground">
        This permanently deletes your account, saved regions and notes. Enter your password to confirm.
      </p>
      <label htmlFor="delete-password" className="mb-1 mt-3 block text-xs font-medium text-muted-foreground">
        Password
      </label>
      <Input id="delete-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      {deleteAccount.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {deleteAccount.error.message}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="danger" size="sm" disabled={deleteAccount.isPending}>
          Delete account
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
