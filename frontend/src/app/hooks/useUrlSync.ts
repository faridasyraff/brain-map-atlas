import { useEffect } from 'react';
import { openRegionRef } from '@/lib/navigate';
import type { Plane } from '@/lib/planes';
import { useAtlas } from '@/store/atlas';

const PARAM: Record<Plane, string> = { sagittal: 'sag', coronal: 'cor', transverse: 'tra' };

/** Read a shared link: slice positions and the selected region or group. */
export function parseLink(search: string) {
  const p = new URLSearchParams(search);
  const slices: Partial<Record<Plane, number>> = {};
  for (const [plane, key] of Object.entries(PARAM) as [Plane, string][]) {
    const n = Number.parseInt(p.get(key) ?? '', 10);
    if (Number.isFinite(n)) slices[plane] = n;
  }
  const region = Number.parseInt(p.get('region') ?? '', 10);
  const group = (p.get('group') ?? '').trim().slice(0, 200);
  const ref =
    Number.isFinite(region) && region > 0
      ? ({ kind: 'region', ref: String(region) } as const)
      : group
        ? ({ kind: 'group', ref: group } as const)
        : null;
  return { slices, ref };
}

/**
 * Shareable links: the address bar always describes the view
 * (/app?region=150&sag=707&cor=660&tra=319, or ?group=Thalamus&…), and
 * opening such a link restores it. Mount once.
 */
export function useUrlSync() {
  useEffect(() => {
    // 1) Restore from the link the page was opened with.
    const { slices, ref } = parseLink(window.location.search);
    const hasSlices = Object.keys(slices).length > 0;
    if (hasSlices) useAtlas.getState().setSlices(slices);
    // With slice positions in the link, keep them (the sender's exact view).
    if (ref) void openRegionRef(ref, { keepSlices: hasSlices });

    // 2) Keep the address bar in step. replaceState: moving a slider
    //    shouldn't flood the back-button history.
    const write = () => {
      const { slices: s, selection } = useAtlas.getState();
      const url = new URL(window.location.href);
      for (const [plane, key] of Object.entries(PARAM) as [Plane, string][]) url.searchParams.set(key, String(s[plane]));
      url.searchParams.delete('region');
      url.searchParams.delete('group');
      if (selection) url.searchParams.set(selection.kind === 'region' ? 'region' : 'group', selection.ref);
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    };
    return useAtlas.subscribe(write);
  }, []);
}
