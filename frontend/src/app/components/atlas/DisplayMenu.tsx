import { useEffect, useId, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

export interface DisplayOptions {
  shell: boolean;
  planes: boolean;
  axes: boolean;
  /** 20 to 100 (%) */
  opacity: number;
}

/** What the 3D view draws: the outline, the section planes, the axis labels,
 *  and how solid the extra surfaces are. A small non-modal panel under its
 *  button; Escape or a click outside closes it. */
export function DisplayMenu({
  options,
  onChange,
  surfaceCount,
  onClearSurfaces,
  disabled,
}: {
  options: DisplayOptions;
  onChange: (o: DisplayOptions) => void;
  surfaceCount: number;
  onClearSurfaces: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes it wherever focus is (a button inside may have just disabled itself).
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const set = (patch: Partial<DisplayOptions>) => onChange({ ...options, ...patch });
  const check = (key: 'shell' | 'planes' | 'axes', label: string) => (
    <label className="flex min-h-7 cursor-pointer items-center gap-2.5 text-[12.5px] max-md:min-h-11">
      <input type="checkbox" className="size-3.5 accent-primary" checked={options[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <div ref={wrap} className="relative">
      <Button
        ref={button}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn('h-7 gap-1.5 px-2 text-[12.5px] max-md:h-11', open && 'bg-hover text-foreground')}
      >
        <SlidersHorizontal />
        Display
      </Button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Display options"
          className="absolute right-0 top-full z-30 mt-1 grid w-60 origin-top-right animate-menu-in gap-1 rounded-lg bg-raised p-3 shadow-menu"
        >
          {check('shell', 'Brain outline')}
          {check('planes', 'Section planes')}
          {check('axes', 'Axis labels')}
          <div className="mt-2 border-t border-border pt-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[12.5px]">
              <span>Surface opacity</span>
              <output className="font-mono text-[11.5px] text-muted-foreground">{options.opacity}%</output>
            </div>
            <Slider
              aria-label="Surface opacity"
              className="text-foreground"
              min={20}
              max={100}
              step={5}
              value={[options.opacity]}
              onValueChange={([v]) => v !== undefined && set({ opacity: v })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border pt-2.5 text-[12.5px]">
            <span className="text-muted-foreground">
              {surfaceCount === 0 ? 'No extra surfaces' : `${surfaceCount} ${surfaceCount === 1 ? 'surface' : 'surfaces'} shown`}
            </span>
            <Button size="sm" className="h-7 px-2.5 text-[12.5px] max-md:h-11" disabled={surfaceCount === 0} onClick={onClearSurfaces}>
              Hide all
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
