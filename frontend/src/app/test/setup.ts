// Adds DOM matchers like toBeInTheDocument() / toHaveAttribute().
// (Testing Library unmounts rendered components after each test by itself,
// because `globals: true` in vite.config.ts exposes afterEach.)
import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver; Radix (slider, tooltip) needs one to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Behave like current Chrome, where scrollIntoView() returns a Promise.
// (jsdom has no scrollIntoView at all.) An effect that accidentally returned
// it crashed the whole app in real browsers while every test passed.
Element.prototype.scrollIntoView = function () {
  return Promise.resolve() as unknown as void;
};

// jsdom has no WebGL: the 3D view gets a recording stand-in (see fakeViewer.ts).
vi.mock('@/lib/three/BrainViewer', () => import('./fakeViewer'));
// jsdom has no canvas contexts; say so quietly instead of logging "Not implemented".
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
