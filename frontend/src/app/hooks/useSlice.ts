import { useEffect, useState } from 'react';
import { fetchSlice, type SliceImage } from '@/lib/api';
import type { Plane } from '@/lib/planes';

export type SliceState =
  | { status: 'loading'; data: SliceImage | null }
  | { status: 'ready'; data: SliceImage }
  | { status: 'error'; data: SliceImage | null; error: string };

/**
 * Loads the slice image for one view. A newer index cancels the request for
 * the older one, so a slow response can never replace a newer image. While
 * loading, the previous image stays on screen (no flash to black).
 */
export function useSlice(view: Plane, idx: number, enabled = true): SliceState {
  const [state, setState] = useState<SliceState>({ status: 'loading', data: null });

  useEffect(() => {
    if (!enabled) return; // hidden view: catch up when shown again
    const ctrl = new AbortController();
    setState((s) => ({ status: 'loading', data: s.data }));
    fetchSlice(view, idx, ctrl.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        setState((s) => ({ status: 'error', data: s.data, error }));
      });
    return () => ctrl.abort();
  }, [view, idx, enabled]);

  return state;
}
