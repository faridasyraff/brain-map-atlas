import { useQuery } from '@tanstack/react-query';
import { getEnrichment } from '@/lib/api';
import type { Selection } from '@/lib/selection';

/** A region's summary, keywords and related regions (shared by the inspector and the phone sheet). */
export function useEnrichment(selection: Selection) {
  return useQuery({
    queryKey: ['enrich', selection.pidx, selection.label, selection.acronym],
    queryFn: ({ signal }) => getEnrichment({ pidx: selection.pidx, name: selection.label, acronym: selection.acronym }, signal),
    staleTime: 10 * 60_000,
  });
}
