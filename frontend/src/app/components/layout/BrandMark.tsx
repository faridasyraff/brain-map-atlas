import { cn } from '@/lib/utils';

/** The "Brain Atlas" name, linking home. Just the wordmark: no logo mark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <a href="/" className={cn('text-[15px] font-semibold text-foreground', className)}>
      Brain Atlas
    </a>
  );
}
