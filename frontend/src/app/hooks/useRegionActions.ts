import { toast } from 'sonner';
import { toLibraryItem, useLibrary } from '@/hooks/useLibrary';
import type { Selection } from '@/lib/selection';
import { useUi } from '@/store/ui';

/** Save / unsave a selection (signing in first if needed) and copy a link to it. */
export function useRegionActions(selection: Selection) {
  const lib = useLibrary();
  const openSignIn = useUi((s) => s.openSignIn);
  const saved = lib.find(selection);

  function toggleSave() {
    if (!lib.signedIn) {
      openSignIn('signin');
      return;
    }
    const item = toLibraryItem(selection);
    const done = saved
      ? lib.unsave.mutateAsync(item).then(() => toast.success(`Removed ${selection.label} from saved regions`))
      : lib.save.mutateAsync(item).then(() => toast.success(`Saved ${selection.label}`));
    done.catch((e: Error) => toast.error('Could not update saved regions', { description: e.message }));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied', { description: 'It reopens this region at these slices.' });
    } catch {
      toast.error('Could not copy automatically', { description: 'Copy the address bar instead.' });
    }
  }

  return {
    saved,
    signedIn: lib.signedIn,
    pending: lib.save.isPending || lib.unsave.isPending,
    toggleSave,
    copyLink: () => void copyLink(),
  };
}
