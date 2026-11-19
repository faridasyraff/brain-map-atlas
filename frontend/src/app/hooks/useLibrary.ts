import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getHistory, getSaved, recordHistory, saveItem, unsaveItem, type LibraryItem, type SavedItem } from '@/lib/api';
import type { Selection } from '@/lib/selection';
import { useAtlas } from '@/store/atlas';
import { useMe } from './useAuth';

const savedKey = ['library', 'saved'] as const;
const historyKey = ['library', 'history'] as const;

export const itemKey = (i: Pick<LibraryItem, 'kind' | 'ref'>) => `${i.kind}:${i.ref}`;

export const toLibraryItem = (s: Selection): LibraryItem => ({
  kind: s.kind,
  ref: s.ref,
  label: s.label,
  acronym: s.acronym === '—' || s.acronym === '--' ? '' : s.acronym,
  color: s.color ?? '',
});

/** The signed-in user's saved regions and history (empty and idle when signed out). */
export function useLibrary() {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const signedIn = !!user;

  const saved = useQuery({ queryKey: savedKey, queryFn: getSaved, enabled: signedIn });
  const history = useQuery({ queryKey: historyKey, queryFn: getHistory, enabled: signedIn });

  const setSaved = (list: SavedItem[]) => qc.setQueryData(savedKey, list);
  const save = useMutation({ mutationFn: saveItem, onSuccess: setSaved });
  const unsave = useMutation({ mutationFn: unsaveItem, onSuccess: setSaved });

  return {
    signedIn,
    saved: signedIn ? (saved.data ?? []) : [],
    history: signedIn ? (history.data ?? []) : [],
    isLoading: saved.isLoading || history.isLoading,
    find: (i: Pick<LibraryItem, 'kind' | 'ref'>) => saved.data?.find((s) => itemKey(s) === itemKey(i)),
    save,
    unsave,
  };
}

/** Records each newly selected region in the signed-in user's history. Mount once. */
export function useRecordHistory() {
  const { data: user } = useMe();
  const selection = useAtlas((s) => s.selection);
  const qc = useQueryClient();
  const key = selection ? itemKey(selection) : null;

  useEffect(() => {
    if (!user || !selection) return;
    recordHistory(toLibraryItem(selection))
      .then(() => qc.invalidateQueries({ queryKey: historyKey }))
      .catch(() => {}); // history is best-effort
    // Re-run only when the selected region changes, not on every render.
  }, [key, user?.email]);
}
