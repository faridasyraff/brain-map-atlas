import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, Layers, LocateFixed, Maximize2, Minimize2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { getAvailableMeshes, getOntology } from '@/lib/api';
import { buildMeshCatalog, meshTargetFor } from '@/lib/meshTarget';
import { identifyPick, type PlanePick } from '@/lib/navigate';
import type { BrainViewer, MeshCatalogMaps, ViewerStatus } from '@/lib/three/BrainViewer';
import { cn } from '@/lib/utils';
import { useAtlas } from '@/store/atlas';

interface ThreeDCellProps {
  expanded?: boolean;
  /** Absent on a phone, where there is nothing to expand into. */
  onToggleExpand?: () => void;
  hidden?: boolean;
}

type Vec3 = PlanePick['local'];
type Anchor = { x: number; y: number; settled: boolean };

const PIN_GAP = 48; // px from the region to the label, along both axes
const EDGE = 12; // keep the label this far inside the canvas
const fmt = (p: Vec3) => `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;

/** The 3D view: shell, selected region, and slice planes that follow the 2D
 *  sliders. eBrain mode paints the planes so they can be clicked. */
export function ThreeDCell({ expanded, onToggleExpand, hidden }: ThreeDCellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewer, setViewer] = useState<BrainViewer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ acronym: '—', name: 'Loading the 3D view…' });
  const [hover, setHover] = useState<Vec3 | null>(null);
  const [lastPick, setLastPick] = useState<PlanePick | null>(null);
  const [shell, setShell] = useState(true);
  const [ebrain, setEbrain] = useState(false);
  // The pinned label: placed straight from the viewer's frame loop (no React render per frame).
  const [pinned, setPinned] = useState(false);
  const pinRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGLineElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);

  const slices = useAtlas((s) => s.slices);
  const selection = useAtlas((s) => s.selection);
  const ontology = useQuery({ queryKey: ['ontology'], queryFn: getOntology, staleTime: Infinity });
  const meshes = useQuery({ queryKey: ['available-meshes'], queryFn: getAvailableMeshes, staleTime: Infinity, retry: false });
  const catalog = useMemo(() => (ontology.data ? buildMeshCatalog(ontology.data) : null), [ontology.data]);
  const maps = useMemo<MeshCatalogMaps>(
    () => ({
      available: meshes.data ?? null,
      parentOf: catalog?.parentOf ?? null,
      nameOf: (id) => catalog?.nodeOf.get(id)?.name,
    }),
    [catalog, meshes.data],
  );
  const target = useMemo(() => (selection ? meshTargetFor(selection, catalog) : null), [selection, catalog]);

  // Create the viewer once. three.js loads on demand, outside the main bundle.
  useEffect(() => {
    let cancelled = false;
    let made: BrainViewer | null = null;
    import('@/lib/three/BrainViewer')
      .then(({ BrainViewer }) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        made = new BrainViewer(canvas, {
          onStatus: setStatus,
          onHover: setHover,
          onAnchor: (a) => {
            placePin(a);
            setPinned(!!a?.settled);
          },
          onPick: (pick) => {
            setLastPick(pick);
            void identifyPick(pick);
          },
        });
        setViewer(made);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const webgl = String(err).toLowerCase().includes('webgl');
        setFailed(webgl ? 'The 3D view needs WebGL, which is turned off or unsupported in this browser.' : 'The 3D view failed to load.');
      });
    return () => {
      cancelled = true;
      made?.dispose();
      setViewer(null);
    };
  }, []);

  useEffect(() => {
    viewer?.setSlices(slices);
  }, [viewer, slices]);

  useEffect(() => {
    if (!viewer) return;
    viewer.setCatalog(maps);
    void viewer.showRegion(target);
  }, [viewer, maps, target]);

  /** Put the label beside the region (up and right, or left near the edge) with a line to it. */
  function placePin(a: Anchor | null) {
    const pin = pinRef.current;
    const line = lineRef.current;
    const dot = dotRef.current;
    const box = canvasRef.current;
    if (!pin || !line || !dot || !box || !a) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    const w = pin.offsetWidth;
    const h = pin.offsetHeight;
    const right = a.x + PIN_GAP + w <= W - EDGE;
    const lx = right ? a.x + PIN_GAP : Math.max(EDGE, a.x - PIN_GAP - w);
    const ly = Math.min(Math.max(EDGE, a.y - PIN_GAP - h / 2), H - h - EDGE);
    pin.style.transform = `translate(${lx}px, ${ly}px)`;
    dot.style.transform = `translate(${a.x}px, ${a.y}px) translate(-50%, -50%)`;
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(right ? lx : lx + w));
    line.setAttribute('y2', String(ly + h / 2));
  }

  function toggleShell() {
    const next = !shell;
    setShell(next);
    viewer?.setShellVisible(next);
  }

  function toggleEbrain() {
    const next = !ebrain;
    setEbrain(next);
    if (!next) {
      setLastPick(null);
      setHover(null);
    }
    // A failure is reported through the status line.
    viewer?.setEbrain(next).catch(() => {});
  }

  return (
    <section aria-label="3D view" hidden={hidden} className="flex min-h-0 min-w-0 flex-1 flex-col bg-stage">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface pl-3.5 pr-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="size-2 rounded-[2px] bg-plane-3d" />
          3D
        </span>
        <span className="ml-auto flex gap-0.5">
          <IconButton label="Recenter camera" onClick={() => viewer?.recenter()} disabled={!viewer}>
            <LocateFixed />
          </IconButton>
          <IconButton label="Brain outline" aria-pressed={shell} onClick={toggleShell} disabled={!viewer} className={cn(shell && 'text-foreground')}>
            <Box />
          </IconButton>
          <IconButton
            label="eBrain mode: click a slice plane to identify a region"
            aria-pressed={ebrain}
            onClick={toggleEbrain}
            disabled={!viewer}
            className={cn(ebrain && 'bg-accent text-plane-3d')}
          >
            <Layers />
          </IconButton>
          {onToggleExpand && (
            <IconButton label={expanded ? 'Show all views' : 'Expand 3D view'} onClick={onToggleExpand}>
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          )}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} aria-label="3D brain" className={cn('block size-full touch-none', ebrain && 'cursor-crosshair')} />
        {/* The pinned label: fades in once the camera has arrived; leaves faster than it came. */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 transition-opacity',
            pinned && target && !failed ? 'opacity-100 delay-120 duration-200 ease-out' : 'opacity-0 duration-100 ease-out',
          )}
        >
          <svg className="absolute inset-0 size-full overflow-visible">
            <line ref={lineRef} stroke="var(--color-muted-foreground)" strokeWidth="1" />
          </svg>
          <span ref={dotRef} className="absolute left-0 top-0 size-2 rounded-full border border-foreground bg-stage" />
          <div
            ref={pinRef}
            className="absolute left-0 top-0 flex max-w-64 items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 py-1.5 shadow-float"
          >
            <span className="size-2.5 shrink-0 rounded-[2px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]" style={{ background: target?.color }} />
            <span className="font-condensed text-xs font-semibold">{target?.acronym}</span>
            <span className="truncate text-xs text-muted-foreground">{target?.name}</span>
          </div>
        </div>
        {failed ? (
          <p role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
            {failed}
          </p>
        ) : (
          // When the pinned label says the same thing, this line only speaks to screen
          // readers; a note like "showing the parent" stays visible.
          <p
            role="status"
            className={cn(
              'pointer-events-none absolute left-3 top-3 max-w-[calc(100%-1.5rem)] truncate text-xs',
              pinned && target && status.name === target.name && 'sr-only',
            )}
          >
            <span className="font-semibold text-foreground">{status.acronym}</span>{' '}
            <span className="text-muted-foreground">{status.name}</span>
          </p>
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-surface px-3.5 text-xs whitespace-nowrap text-subtle-foreground">
        {ebrain ? (
          <>
            <span>
              Pointer <span className="text-foreground">{hover ? fmt(hover) : '—'}</span> µm
            </span>
            <span className="truncate">
              Clicked <span className="text-foreground">{lastPick ? `${lastPick.view} plane at ${fmt(lastPick.local)}` : '—'}</span>
              {lastPick && ' µm'}
            </span>
          </>
        ) : (
          <span>Drag to orbit, scroll to zoom. Turn on eBrain to click the planes.</span>
        )}
      </footer>
    </section>
  );
}
