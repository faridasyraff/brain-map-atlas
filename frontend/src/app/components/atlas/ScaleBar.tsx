import { useEffect, useState, type RefObject } from 'react';
import { niceScale } from '@/lib/scale';
import { cn } from '@/lib/utils';

/** A round length (500 µm, 1 mm, ...) drawn to scale: a bracket with its label above. */
export function ScaleBar({ pxPerUm, className, title }: { pxPerUm: number | null; className?: string; title?: string }) {
  const s = pxPerUm ? niceScale(pxPerUm) : null;
  if (!s) return null;
  return (
    <div
      role="img"
      aria-label={`Scale bar, ${s.label}`}
      className={cn('pointer-events-none absolute font-mono text-[11px] text-muted-foreground', className)}
      title={title}
    >
      <span aria-hidden>{s.label}</span>
      <span aria-hidden className="mt-0.5 block h-[5px] border-x border-b border-current" style={{ width: s.px }} />
    </div>
  );
}

export type ScaleListener = (pxPerUm: number) => void;

/** The 3D scale bar: the viewer reports the scale through `listen` as the camera
 *  zooms, and only this component re-renders. */
export function LiveScaleBar({ listen, className }: { listen: RefObject<ScaleListener | null>; className?: string }) {
  const [pxPerUm, setPxPerUm] = useState<number | null>(null);
  useEffect(() => {
    listen.current = setPxPerUm;
    return () => {
      listen.current = null;
    };
  }, [listen]);
  return <ScaleBar pxPerUm={pxPerUm} className={className} title="Scale at the centre of rotation (the 3D view has perspective)" />;
}
