import { useQuery } from '@tanstack/react-query';
import { AccountMenu } from '@/components/account/AccountMenu';
import { BrandMark } from '@/components/layout/BrandMark';
import { fetchSlice } from '@/lib/api';
import { ATLAS_PATH, atlasGroupLink } from '@/lib/paths';
import { cn } from '@/lib/utils';

const PLANES = [
  { name: 'Sagittal', swatch: 'bg-plane-sagittal', what: 'Side view, stepping left to right' },
  { name: 'Coronal', swatch: 'bg-plane-coronal', what: 'Front view, stepping front to back' },
  { name: 'Transverse', swatch: 'bg-plane-transverse', what: 'Top view, stepping top to bottom' },
  { name: '3D', swatch: 'bg-plane-3d', what: 'The selected region inside the whole brain' },
];

const HERO_SLICE = 660;
const link = 'inline-flex h-12 items-center rounded-lg text-base no-underline transition-colors';

/** The home page: what the atlas is, a real section from it, and the way in. */
export function Landing() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-8">
        <BrandMark className="text-base" />
        <nav aria-label="Account">
          <AccountMenu />
        </nav>
      </header>

      <main className="flex flex-1 items-center px-5 py-12 sm:px-8 sm:py-16">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-14">
          <div className="min-w-0 flex-[5_1_420px]">
            <h1 className="mb-5 max-w-[16ch] text-[clamp(2.25rem,6vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.025em] text-white text-balance">
              The Allen mouse brain, region by region
            </h1>
            <p className="mb-8 max-w-[52ch] text-lg leading-relaxed text-muted-foreground">
              Browse the Allen CCFv3 reference atlas in linked sagittal, coronal and transverse sections alongside a 3D model.
              Click any point to identify the region, search every structure by name or acronym, and ask the assistant what a
              region does.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a href={ATLAS_PATH} className={cn(link, 'bg-primary px-6 font-semibold text-primary-foreground hover:bg-white')}>
                Open the atlas
              </a>
              <a
                href={atlasGroupLink('Hippocampal formation')}
                className={cn(link, 'border border-border-strong px-5 font-medium text-foreground hover:bg-hover')}
              >
                Try the hippocampus
              </a>
            </div>

            <dl className="mt-14 grid grid-cols-1 gap-x-8 gap-y-5 border-t border-border pt-7 min-[480px]:grid-cols-2">
              {PLANES.map((p) => (
                <div key={p.name}>
                  <dt className="flex items-center gap-2 text-sm font-semibold">
                    <span aria-hidden className={cn('size-2.5 rounded-[2px]', p.swatch)} />
                    {p.name}
                  </dt>
                  <dd className="mt-1 text-sm text-muted-foreground">{p.what}</dd>
                </div>
              ))}
            </dl>
          </div>

          <HeroSection />
        </div>
      </main>

      <footer className="border-t border-border px-5 py-5 text-[13px] text-subtle-foreground sm:px-8">
        Atlas data: Allen Mouse Brain Common Coordinate Framework v3 (CCFv3), Allen Institute for Brain Science.
      </footer>
    </div>
  );
}

/** A real coronal section, rendered by the same endpoint the atlas views use. */
function HeroSection() {
  const slice = useQuery({
    queryKey: ['slice', 'coronal', HERO_SLICE],
    queryFn: ({ signal }) => fetchSlice('coronal', HERO_SLICE, signal),
    staleTime: Infinity,
  });
  return (
    <figure className="m-0 min-w-0 flex-[6_1_480px] max-sm:basis-full">
      <div className="grid aspect-[1000/702] place-items-center overflow-hidden rounded-xl border border-border bg-canvas">
        {slice.data ? (
          <img
            src={slice.data.image}
            alt="Coronal section of the mouse brain, colored by Allen region"
            className="block size-full object-contain"
          />
        ) : (
          <p role={slice.isError ? 'alert' : 'status'} className="max-w-[40ch] p-6 text-center text-sm text-muted-foreground">
            {slice.isError
              ? 'The atlas preview could not be loaded. The atlas server may still be starting up.'
              : 'Loading a section from the atlas…'}
          </p>
        )}
      </div>
      <figcaption className="mt-3 text-[13px] text-subtle-foreground">
        Coronal section {HERO_SLICE} of 1,320 from the Allen CCFv3 annotation, colored by structure.
      </figcaption>
    </figure>
  );
}
