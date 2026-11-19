import { useCallback, useEffect, useRef, useState } from 'react';
import { IDENTITY, TAP_SLOP, wheelFactor, zoomAround, type ViewTransform } from '@/lib/zoom';

type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pan'; start: Point; origin: ViewTransform; moved: boolean }
  | { kind: 'pinch'; dist: number; mid: Point; origin: ViewTransform };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Zoom (wheel, toward the cursor; two-finger pinch) and pan (drag) for one
 * view. Attach `ref` to the viewport and apply `transform` to the layer
 * inside it. A press that doesn't move more than a few pixels is a tap and
 * calls `onTap` with its client position; anything more is a pan and does not.
 */
export function usePanZoom(onTap: (clientX: number, clientY: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<ViewTransform>(IDENTITY);
  const current = useRef(transform);
  const tapRef = useRef(onTap);
  useEffect(() => {
    tapRef.current = onTap;
  });

  const apply = useCallback((t: ViewTransform) => {
    current.current = t;
    setTransform(t);
  }, []);
  const reset = useCallback(() => apply(IDENTITY), [apply]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pointers = new Map<number, Point>();
    let gesture: Gesture | null = null;
    const local = (p: Point): Point => {
      const r = el.getBoundingClientRect();
      return { x: p.x - r.left, y: p.y - r.top };
    };
    const startPan = (p: Point, moved: boolean) => {
      gesture = { kind: 'pan', start: p, origin: current.current, moved };
    };
    const startPinch = () => {
      const [a, b] = [...pointers.values()] as [Point, Point];
      gesture = { kind: 'pinch', dist: Math.max(1, dist(a, b)), mid: local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), origin: current.current };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // zoom the view, not the page
      const t = current.current;
      apply(zoomAround(t, t.zoom * wheelFactor(e.deltaY, e.deltaMode), local({ x: e.clientX, y: e.clientY })));
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture?.(e.pointerId);
      if (pointers.size === 1) startPan({ x: e.clientX, y: e.clientY }, false);
      else if (pointers.size === 2) startPinch();
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture;
      if (g?.kind === 'pan') {
        const dx = e.clientX - g.start.x;
        const dy = e.clientY - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
        g.moved = true;
        el.dataset.panning = '';
        apply({ ...g.origin, x: g.origin.x + dx, y: g.origin.y + dy });
      } else if (g?.kind === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()] as [Point, Point];
        const mid = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const zoomed = zoomAround(g.origin, (g.origin.zoom * dist(a, b)) / g.dist, g.mid);
        apply({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y });
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      const g = gesture;
      if (pointers.size === 0) {
        gesture = null;
        delete el.dataset.panning;
        if (e.type === 'pointerup' && g?.kind === 'pan' && !g.moved) tapRef.current(e.clientX, e.clientY);
      } else if (pointers.size === 1) {
        // One finger of a pinch lifted: carry on panning with the other, never a tap.
        startPan([...pointers.values()][0]!, true);
      } else {
        startPinch();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [apply]);

  return { ref, transform, reset };
}
