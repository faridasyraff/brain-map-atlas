/** The three 2D slice planes, plus the 3D view. */
export type Plane = 'sagittal' | 'coronal' | 'transverse';
export type ViewId = Plane | 'three-d';

export interface PlaneConfig {
  id: Plane;
  label: string;
  /** Which way the slider moves through the brain (short, for the header). */
  axis: string;
  axisTitle: string;
  /** Slider range: the slices that actually contain brain. */
  min: number;
  max: number;
  initial: number;
}

// Ranges match the current app (index.html). The colors live in the theme
// (globals.css) as plane-sagittal / plane-coronal / plane-transverse / plane-3d.
export const PLANES: Record<Plane, PlaneConfig> = {
  sagittal: { id: 'sagittal', label: 'Sagittal', axis: 'L–R', axisTitle: 'left to right', min: 51, max: 1087, initial: 570 },
  coronal: { id: 'coronal', label: 'Coronal', axis: 'A–P', axisTitle: 'anterior to posterior', min: 0, max: 1319, initial: 660 },
  transverse: { id: 'transverse', label: 'Transverse', axis: 'S–I', axisTitle: 'superior to inferior', min: 14, max: 757, initial: 400 },
};

export const PLANE_ORDER: Plane[] = ['sagittal', 'coronal', 'transverse'];

/** Tailwind classes per view: the dot/thumb color. Written out in full so
 *  Tailwind can see them (it doesn't understand built-up class names). */
export const PLANE_COLOR_CLASS: Record<ViewId, { bg: string; text: string }> = {
  sagittal: { bg: 'bg-plane-sagittal', text: 'text-plane-sagittal' },
  coronal: { bg: 'bg-plane-coronal', text: 'text-plane-coronal' },
  transverse: { bg: 'bg-plane-transverse', text: 'text-plane-transverse' },
  'three-d': { bg: 'bg-plane-3d', text: 'text-plane-3d' },
};
