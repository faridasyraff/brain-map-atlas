import { cn } from '@/lib/utils';

/** The "Brain Atlas" logo and name, linking home. */
export function BrandMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <a href="/" className={cn('flex items-center gap-2.5 text-[15px] font-semibold text-foreground', className)}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <ellipse cx="12" cy="12" rx="9" ry="7" stroke="var(--color-plane-sagittal)" strokeWidth="2" />
        <path d="M12 5v14" stroke="var(--color-plane-coronal)" strokeWidth="2" />
      </svg>
      Brain Atlas
    </a>
  );
}
