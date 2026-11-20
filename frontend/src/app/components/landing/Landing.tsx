import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AccountMenu } from '@/components/account/AccountMenu';
import { BrandMark } from '@/components/layout/BrandMark';
import { fetchSlice, getOntology, type OntologyNode } from '@/lib/api';
import { ATLAS, CITATION, IMAGE_CREDIT } from '@/lib/atlasFacts';
import { ATLAS_PATH, atlasGroupLink } from '@/lib/paths';
import { PLANES, type Plane } from '@/lib/planes';
import { isHexColor } from '@/lib/selection';
import type { HomeBrain, HomeRegion } from '@/lib/three/HomeBrain';
import { cn } from '@/lib/utils';
import stillBrain from '@/assets/home-brain.webp';

/** The major divisions drawn in the hero, by Allen structure ID. */
const HERO_REGIONS = [315, 698, 1089, 477, 803, 549, 1097, 313, 771, 354, 512];
const HERO_SLICE = 660;

const pill = 'pressable inline-flex h-12 items-center rounded-full px-6 text-base no-underline';

/** The home page: a darkfield. What the atlas is, the brain itself to turn
 *  and name, the three linked sections, and the way in. */
export function Landing() {
  const root = useReveal();
  return (
    <div ref={root} className="min-h-full bg-home-ink font-home text-home-fg">
      <header className="mx-auto flex h-[72px] w-full max-w-[1200px] items-center gap-6 px-5 sm:px-8">
        <BrandMark className="mr-auto text-base text-home-fg" />
        <a href="#how" className="text-[15px] text-home-muted no-underline hover:text-home-fg max-sm:hidden">
          How it works
        </a>
        <nav aria-label="Account" className="[&_button]:text-[14px]">
          <AccountMenu />
        </nav>
      </header>

      <main>
        <section aria-labelledby="hero-title" className="mx-auto grid min-h-[calc(100svh-72px)] w-full max-w-[1200px] items-center gap-6 px-5 pb-10 sm:px-8 lg:grid-cols-[minmax(0,500px)_minmax(0,1fr)]">
          <div>
            <h1
              id="hero-title"
              data-reveal
              className="mb-6 font-serif text-[clamp(2.6rem,5.6vw,4.1rem)] font-normal leading-[1.04] tracking-[-0.015em] text-balance"
            >
              Find any region of the mouse brain
            </h1>
            <p data-reveal style={{ '--d': '70ms' } as React.CSSProperties} className="mb-8 max-w-[34em] text-[17px] leading-relaxed text-home-muted">
              A free, linked atlas of the Allen Mouse Brain Common Coordinate Framework, for students and researchers. Click a
              point in any section and the region is named, in 2D and in 3D, with what it does in plain words.
            </p>
            <div data-reveal style={{ '--d': '140ms' } as React.CSSProperties} className="flex flex-wrap gap-3">
              <a href={ATLAS_PATH} className={cn(pill, 'bg-home-primary font-semibold text-home-ink hover:bg-home-fg')}>
                Open the atlas
              </a>
              <a href={atlasGroupLink('Hippocampal formation')} className={cn(pill, 'glass font-medium text-home-fg hover:bg-white/10')}>
                Try the hippocampus
              </a>
            </div>
            <p data-reveal style={{ '--d': '210ms' } as React.CSSProperties} className="mt-10 max-w-[26rem] border-t border-white/10 pt-5 text-[15px] text-home-subtle">
              <span className="mb-1 block font-serif text-[30px] leading-none text-home-fg">1,320 coronal sections</span>
              at {ATLAS.voxelUm} µm, with 1,327 named structures
            </p>
          </div>
          <BrainStage />
        </section>

        <section id="how" aria-labelledby="how-title" className="mx-auto grid w-full max-w-[1200px] items-center gap-12 px-5 py-24 sm:px-8 lg:min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-20">
          <SectionPlates />
          <div>
            <h2 id="how-title" data-reveal className="mb-5 font-serif text-[clamp(2rem,3.6vw,2.9rem)] font-normal leading-[1.1] tracking-[-0.01em] text-balance">
              Three sections through one point
            </h2>
            <p data-reveal style={{ '--d': '70ms' } as React.CSSProperties} className="mb-4 text-[17px] leading-relaxed text-home-muted">
              Sagittal, coronal and transverse sections cross at one point. Click anywhere in one and the other two move to
              it. The region there is named, outlined in each view and shown in 3D.
            </p>
            <p data-reveal style={{ '--d': '140ms' } as React.CSSProperties} className="text-[17px] leading-relaxed text-home-muted">
              Every section is real atlas data at 10 µm, coloured the way the Allen Institute colours it. Search any of the
              structures by name or acronym, save the ones you study, and ask the assistant what a region does.
            </p>
          </div>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-[1200px] px-5 pb-8 sm:px-8">
        <div className="border-t border-white/10 pt-5">
          <p className="max-w-[60ch] text-[13px] leading-relaxed text-home-subtle">
          Atlas data and images: Allen Mouse Brain Common Coordinate Framework v3, Allen Institute for Brain Science,{' '}
          <a className="text-home-muted underline-offset-2 hover:underline" href={ATLAS.dataUrl} target="_blank" rel="noreferrer">
            atlas.brain-map.org
          </a>
          . {IMAGE_CREDIT} {CITATION.text}{' '}
          <a className="text-home-muted underline-offset-2 hover:underline" href={`https://doi.org/${CITATION.doi}`} target="_blank" rel="noreferrer">
            doi:{CITATION.doi}
          </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

/** Elements marked `data-reveal` rise into place the first time they scroll
 *  into view (a CSS transition on a spring curve, so a quick scroll retargets
 *  instead of restarting). Without JS, or before this runs, nothing is hidden. */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    document.documentElement.dataset.reveals = 'on';
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.shown = '';
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    el.querySelectorAll('[data-reveal]').forEach((n) => io.observe(n));
    return () => {
      io.disconnect();
      delete document.documentElement.dataset.reveals;
    };
  }, []);
  return ref;
}

/** The hero: the real brain surfaces, turned by dragging, named on hover. */
function BrainStage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [hover, setHover] = useState<{ region: HomeRegion; x: number; y: number } | null>(null);
  const ontology = useQuery({ queryKey: ['ontology'], queryFn: getOntology, staleTime: Infinity });
  const regions = useMemo(() => (ontology.data ? heroRegions(ontology.data) : null), [ontology.data]);

  useEffect(() => {
    if (ontology.isError) setState('failed');
  }, [ontology.isError]);

  useEffect(() => {
    if (!regions) return;
    let cancelled = false;
    let made: HomeBrain | null = null;
    import('@/lib/three/HomeBrain')
      .then(({ HomeBrain }) => {
        if (cancelled || !canvas.current) return;
        made = new HomeBrain(canvas.current, regions, {
          onHover: setHover,
          onReady: () => setState('ready'),
          onError: () => setState('failed'),
        });
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
      made?.dispose();
    };
  }, [regions]);

  return (
    <figure className="relative m-0 aspect-[4/3] w-full max-lg:max-h-[56svh]">
      {state === 'failed' ? (
        <img src={stillBrain} alt="The mouse brain in 3D, its major regions in their Allen atlas colours" className="size-full object-contain" />
      ) : (
        <canvas
          ref={canvas}
          aria-label="The mouse brain in 3D, its major regions in their Allen atlas colours. Drag to turn it."
          className={cn('block size-full cursor-grab touch-pan-y transition-opacity duration-500 ease-out active:cursor-grabbing', state === 'ready' ? 'opacity-100' : 'opacity-0')}
        />
      )}
      {hover && (
        <span
          aria-hidden
          className="glass pointer-events-none absolute left-0 top-0 rounded-xl px-3 py-1.5 text-[14px] whitespace-nowrap"
          style={{ transform: `translate(${hover.x + 14}px, ${hover.y - 40}px)` }}
        >
          <b className="font-semibold">{hover.region.acronym}</b>
          {hover.region.name !== hover.region.acronym && <span className="ml-1.5 text-home-muted">{hover.region.name}</span>}
        </span>
      )}
      {state === 'ready' && (
        <figcaption className="sr-only">Drag to turn the brain. Point at a region to name it.</figcaption>
      )}
      <p aria-hidden className={cn('absolute bottom-0 left-1/2 w-max max-w-full -translate-x-1/2 text-center text-[14px] text-home-subtle transition-opacity duration-300', state === 'ready' ? 'opacity-100' : 'opacity-0')}>
        Drag to turn the brain. Point at a region to name it.
      </p>
      {state === 'loading' && (
        <p role="status" className="absolute inset-0 grid place-items-center text-[14px] text-home-subtle">
          Loading the brain…
        </p>
      )}
    </figure>
  );
}

function heroRegions(roots: OntologyNode[]): HomeRegion[] {
  const byId = new Map<number, OntologyNode>();
  const walk = (n: OntologyNode) => {
    byId.set(n.id, n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return HERO_REGIONS.flatMap((id) => {
    const n = byId.get(id);
    if (!n) return [];
    return [{ id, acronym: n.acronym, name: n.name, color: isHexColor(n._color) ? n._color : '#888888' }];
  });
}

/** The three sections at the atlas's starting point, as overlapping glass plates. */
function SectionPlates() {
  const plates: { plane: Plane; className: string; delay: string }[] = [
    // Overlapping only at the corners, so each section stays readable.
    { plane: 'sagittal', className: 'left-0 top-[5%] w-[54%]', delay: '0ms' },
    { plane: 'transverse', className: 'left-[24%] top-[47%] w-[44%]', delay: '90ms' },
    { plane: 'coronal', className: 'right-0 top-0 w-[47%]', delay: '180ms' },
  ];
  return (
    <div className="relative aspect-[5/4] w-full">
      {plates.map((p) => (
        <Plate key={p.plane} plane={p.plane} className={p.className} delay={p.delay} />
      ))}
    </div>
  );
}

/** Each section's size in voxels (width × height), fixed by the atlas. */
const SECTION_SIZE: Record<Plane, [number, number]> = { sagittal: [1320, 800], coronal: [1140, 800], transverse: [1320, 1140] };

/**
 * The part of each plate's section that is shown, in % of the image: the
 * labelled brain plus a small margin, measured on these exact slices. The
 * sagittal one drops its left seventh, empty but for a smear of template
 * tissue outside the atlas, so the brain fills its plate.
 */
const PLATE_CROP: Record<Plane, { x: number; y: number; w: number; h: number }> = {
  sagittal: { x: 14.5, y: 5, w: 85.5, h: 92 },
  transverse: { x: 0, y: 1.5, w: 100, h: 97 },
  coronal: { x: 3, y: 0, w: 94, h: 98 },
};

function Plate({ plane, className, delay }: { plane: Plane; className: string; delay: string }) {
  const idx = plane === 'coronal' ? HERO_SLICE : PLANES[plane].initial;
  const slice = useQuery({
    queryKey: ['slice', plane, idx],
    queryFn: ({ signal }) => fetchSlice(plane, idx, signal),
    staleTime: Infinity,
  });
  const [width, height] = SECTION_SIZE[plane];
  const crop = PLATE_CROP[plane];
  return (
    <div data-reveal style={{ '--d': delay } as React.CSSProperties} className={cn('glass absolute rounded-2xl p-3 shadow-[0_30px_60px_rgb(0_0_0/0.5)]', className)}>
      <div
        className="relative grid place-items-center overflow-hidden rounded-lg bg-canvas"
        style={{ aspectRatio: `${(width * crop.w) / 100} / ${(height * crop.h) / 100}` }}
      >
        {slice.data ? (
          <img
            src={slice.data.image}
            alt={`${PLANES[plane].label} section of the mouse brain, colored by Allen region`}
            className="absolute block max-w-none"
            style={{
              width: `${10000 / crop.w}%`,
              height: `${10000 / crop.h}%`,
              left: `${(-100 * crop.x) / crop.w}%`,
              top: `${(-100 * crop.y) / crop.h}%`,
            }}
          />
        ) : (
          <p role={slice.isError ? 'alert' : 'status'} className="max-w-[30ch] p-4 text-center text-[13px] text-home-subtle">
            {slice.isError ? 'This section could not be loaded. The atlas server may still be starting up.' : 'Loading a section…'}
          </p>
        )}
      </div>
    </div>
  );
}
