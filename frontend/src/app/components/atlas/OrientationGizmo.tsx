import { useEffect, useRef, type RefObject } from 'react';
import type { CameraView, Orientation } from '@/lib/three/BrainViewer';
import { cn } from '@/lib/utils';

/** Each end of the three anatomical axes. An axis wears the colour of the
 *  plane it crosses at right angles (AP crosses the coronal plane, and so on). */
const ENDS: { view: Exclude<CameraView, '3d'>; axis: keyof Orientation; sign: 1 | -1; side: string; color: string }[] = [
  { view: 'P', axis: 'p', sign: 1, side: 'posterior', color: 'var(--color-plane-coronal)' },
  { view: 'A', axis: 'p', sign: -1, side: 'anterior', color: 'var(--color-plane-coronal)' },
  { view: 'D', axis: 'd', sign: 1, side: 'dorsal', color: 'var(--color-plane-transverse)' },
  { view: 'V', axis: 'd', sign: -1, side: 'ventral', color: 'var(--color-plane-transverse)' },
  { view: 'R', axis: 'r', sign: 1, side: 'right', color: 'var(--color-plane-sagittal)' },
  { view: 'L', axis: 'r', sign: -1, side: 'left', color: 'var(--color-plane-sagittal)' },
];
const SIZE = 88; // px, the gizmo's box
const C = SIZE / 2;
const R = 28; // px from the centre to an axis end

export type OrientationListener = (o: Orientation) => void;

/** Which way is dorsal, posterior and right, drawn from the camera's point of
 *  view. The viewer drives it through `listen` on every camera move (no React
 *  render per frame). Clicking an end looks at the brain from that side; the
 *  same views are on the keyboard-reachable preset buttons, so this stays a
 *  pointer shortcut. */
export function OrientationGizmo({ listen, onPick, className }: { listen: RefObject<OrientationListener | null>; onPick: (v: CameraView) => void; className?: string }) {
  const ends = useRef<(HTMLButtonElement | null)[]>([]);
  const lines = useRef<(SVGLineElement | null)[]>([]);

  useEffect(() => {
    listen.current = (o) => {
      ENDS.forEach((e, i) => {
        const v = o[e.axis];
        const x = C + R * v.x * e.sign;
        const y = C - R * v.y * e.sign;
        const el = ends.current[i];
        if (el) {
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
          el.style.zIndex = String(Math.round((v.z * e.sign + 1) * 10)); // nearer ends on top
        }
        const line = lines.current[i];
        if (line) {
          line.setAttribute('x2', String(x));
          line.setAttribute('y2', String(y));
        }
      });
    };
    return () => {
      listen.current = null;
    };
  }, [listen]);

  return (
    <div aria-hidden className={cn('pointer-events-none absolute', className)} style={{ width: SIZE, height: SIZE }}>
      <svg className="absolute inset-0 size-full overflow-visible">
        {ENDS.map((e, i) =>
          e.sign === 1 ? (
            <line key={e.view} ref={(el) => void (lines.current[i] = el)} x1={C} y1={C} x2={C} y2={C} stroke={e.color} strokeWidth={1.5} />
          ) : null,
        )}
      </svg>
      {ENDS.map((e, i) => (
        <button
          key={e.view}
          ref={(el) => void (ends.current[i] = el)}
          type="button"
          tabIndex={-1}
          title={`View from ${e.side}`}
          onClick={() => onPick(e.view)}
          className={cn(
            'pressable pointer-events-auto absolute left-0 top-0 grid place-items-center rounded-full font-mono font-bold text-black',
            'hover:shadow-[0_0_0_2px_var(--color-foreground)]',
            e.sign === 1 ? 'size-5 text-[11px]' : 'size-3 opacity-55 hover:opacity-100',
          )}
          style={{ background: e.color, transform: `translate(${C}px, ${C}px) translate(-50%, -50%)` }}
        >
          {e.sign === 1 ? e.view : null}
        </button>
      ))}
    </div>
  );
}
