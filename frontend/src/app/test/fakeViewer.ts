import { vi } from 'vitest';
import type { BrainViewerEvents } from '@/lib/three/BrainViewer';

/**
 * Stands in for the WebGL viewer (jsdom has no WebGL). setup.ts mocks
 * '@/lib/three/BrainViewer' with this module; tests inspect `viewers` to see
 * what the 3D view was told, and call `events` to act like the user.
 */
export const viewers: BrainViewer[] = [];

export class BrainViewer {
  setSlices = vi.fn();
  setCatalog = vi.fn();
  showRegion = vi.fn(async () => {});
  recenter = vi.fn();
  viewFrom = vi.fn();
  refreshOverlays = vi.fn();
  setSurfaces = vi.fn(async () => {});
  setSurfaceOpacity = vi.fn();
  setPlanesVisible = vi.fn();
  setAxesVisible = vi.fn();
  setShellVisible = vi.fn();
  setEbrain = vi.fn(async () => {});
  dispose = vi.fn();

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly events: BrainViewerEvents,
  ) {
    viewers.push(this);
  }
}

/** The viewer of the mounted 3D view. */
export const liveViewer = () => viewers.filter((v) => v.dispose.mock.calls.length === 0).at(-1);
