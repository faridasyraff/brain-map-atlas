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
    <section aria-label="3D view" hidden={hidden} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0d10]">
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
        {failed ? (
          <p role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
            {failed}
          </p>
        ) : (
          <p role="status" className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-1.5rem)] truncate text-xs">
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
              Clicked <span className="text-foreground">{lastPick ? `${lastPick.view} · ${fmt(lastPick.local)}` : '—'}</span>
            </span>
          </>
        ) : (
          <span>Drag to orbit · scroll to zoom · turn on eBrain to click the planes</span>
        )}
      </footer>
    </section>
  );
}
