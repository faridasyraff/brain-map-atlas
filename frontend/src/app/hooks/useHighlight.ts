import { useQuery } from '@tanstack/react-query';
import { highlightGroupLevel, highlightIndices, highlightRegion } from '@/lib/api';
import type { Plane } from '@/lib/planes';
import { highlightKey, type Highlight } from '@/lib/selection';

/** The overlay marking the selection on one slice (null when nothing is selected). */
export function useHighlight(plane: Plane, idx: number, highlight: Highlight | undefined) {
  return useQuery({
    queryKey: ['highlight', plane, idx, highlight ? highlightKey(highlight) : null],
    enabled: !!highlight,
    staleTime: Infinity, // a given slice + selection always looks the same
    queryFn: ({ signal }) => {
      const h = highlight!;
      if (h.type === 'region') return highlightRegion(plane, idx, h.pidx, signal);
      if (h.type === 'indices') return highlightIndices(plane, idx, h.indices, signal);
      return highlightGroupLevel(plane, idx, h.level, h.name, signal);
    },
  });
}
