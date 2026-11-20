import * as React from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm text-foreground',
        'placeholder:text-subtle-foreground transition-colors hover:border-muted-foreground/40',
        'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20',
        '[&::-webkit-search-cancel-button]:hidden',
        className,
      )}
      {...props}
    />
  );
}
