import { create } from 'zustand';
import type { Center } from '@/lib/api';
import { PLANES, type Plane } from '@/lib/planes';
import type { Selection } from '@/lib/selection';

export type Slices = Record<Plane, number>;

const clamp = (plane: Plane, idx: number) => Math.min(PLANES[plane].max, Math.max(PLANES[plane].min, Math.round(idx)));

export const initialSlices = (): Slices => ({
  sagittal: PLANES.sagittal.initial,
  coronal: PLANES.coronal.initial,
  transverse: PLANES.transverse.initial,
});

/** Which slice of each plane passes through a 3D point. */
export const slicesFromCenter = (c: Center): Slices => ({
  sagittal: clamp('sagittal', c.xi),
  coronal: clamp('coronal', c.zi),
  transverse: clamp('transverse', c.yi),
});

interface AtlasState {
  slices: Slices;
  selection: Selection | null;
  setSlice: (plane: Plane, idx: number) => void;
  setSlices: (slices: Partial<Slices>) => void;
  /** Select a region/group. With `center`, the views move to show it (all but `keep`, if given). */
  select: (selection: Selection | null, center?: Center, keep?: Plane) => void;
}

/** Shared atlas state: where each view is, and what's selected. */
export const useAtlas = create<AtlasState>()((set) => ({
  slices: initialSlices(),
  selection: null,
  setSlice: (plane, idx) => set((s) => ({ slices: { ...s.slices, [plane]: clamp(plane, idx) } })),
  setSlices: (partial) =>
    set((s) => {
      const next = { ...s.slices };
      for (const [p, v] of Object.entries(partial) as [Plane, number | undefined][]) {
        if (v !== undefined && Number.isFinite(v)) next[p] = clamp(p, v);
      }
      return { slices: next };
    }),
  select: (selection, center, keep) =>
    set((s) => {
      if (!center) return { selection };
      const slices = slicesFromCenter(center);
      if (keep) slices[keep] = s.slices[keep];
      return { selection, slices };
    }),
}));
