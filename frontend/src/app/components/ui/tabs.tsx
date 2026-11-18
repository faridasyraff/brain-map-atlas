import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

/** shadcn/ui-style tabs (Radix: arrow-key navigation and ARIA roles built in). */
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex gap-5 border-b border-border px-5', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative h-11 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
        'data-[state=active]:font-semibold data-[state=active]:text-foreground',
        'data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px',
        'data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-t data-[state=active]:after:bg-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('min-h-0 flex-1 overflow-y-auto', className)} {...props} />;
}
