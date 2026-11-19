import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/utils';

/** shadcn/ui-style single-thumb slider. The thumb takes the current text
 *  color, so `className="text-plane-coronal"` tints it per view. */
export function Slider({
  className,
  'aria-label': ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn('relative flex h-5 w-full touch-none select-none items-center', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-border-strong">
        <SliderPrimitive.Range className="absolute h-full bg-current opacity-40" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        className="block size-3.5 rounded-full border-2 border-surface bg-current shadow-[0_0_0_1px_currentColor] transition-transform hover:scale-110"
      />
    </SliderPrimitive.Root>
  );
}
