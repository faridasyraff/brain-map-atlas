/** Zoom and pan of one 2D view, as a CSS transform: translate(x, y) scale(zoom), origin top-left. */
export interface ViewTransform {
  zoom: number;
  x: number;
  y: number;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 10;
export const IDENTITY: ViewTransform = { zoom: 1, x: 0, y: 0 };

/** How far (px) a pointer may move and still count as a click, not a drag. */
export const TAP_SLOP = 4;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export const isIdentity = (t: ViewTransform) => t.zoom === 1 && t.x === 0 && t.y === 0;

/**
 * Zoom from `from` to `zoom` (clamped) so the content under `point` (container
 * px) stays put. Also used for pinch: pass the pinch midpoint.
 */
export function zoomAround(from: ViewTransform, zoom: number, point: { x: number; y: number }): ViewTransform {
  const z = clampZoom(zoom);
  const k = z / from.zoom;
  return { zoom: z, x: (from.x - point.x) * k + point.x, y: (from.y - point.y) * k + point.y };
}

/** One wheel event's zoom factor. Smooth for trackpads, ~10% per mouse notch. */
export const wheelFactor = (deltaY: number, deltaMode: number) => {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-100, Math.min(100, px)) * 0.001);
};
