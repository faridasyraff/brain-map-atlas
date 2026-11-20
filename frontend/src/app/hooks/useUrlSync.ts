import { useEffect, useState } from 'react';
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
  // The link the page was opened with, read once. A region without slice
  // positions (e.g. the home page's hippocampus link) holds the views back until
  // its position is known, so they load once, in the right place. Decided while
  // the root renders, before any view mounts: React runs the views' effects
  // (which fetch slices) before this component's own.
  const [link] = useState(() => {
    const parsed = parseLink(window.location.search);
    if (parsed.ref && Object.keys(parsed.slices).length === 0) useAtlas.setState({ opening: true });
    return parsed;
  });

  useEffect(() => {
    // 1) Restore from the link. With slice positions, keep them (the sender's exact view).
    const { slices, ref } = link;
    const hasSlices = Object.keys(slices).length > 0;
    if (hasSlices) useAtlas.getState().setSlices(slices);
    let done = false;
    const release = () => {
      if (!done) useAtlas.setState({ opening: false });
      done = true;
    };
    // A slow or stuck lookup must not leave the views blank: show the default slices after 4 s.
    const fallback = window.setTimeout(release, 4000);
    if (ref) void openRegionRef(ref, { keepSlices: hasSlices }).finally(release);

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
    const unsubscribe = useAtlas.subscribe(write);
    return () => {
      unsubscribe();
      // A rerun (StrictMode) opens the link again and releases the views itself:
      // this run's lookup, superseded and settling first, must not release them early.
      done = true;
      window.clearTimeout(fallback);
    };
  }, [link]);
}
