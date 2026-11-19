import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/utils';

/** shadcn/ui-style single-thumb slider. The thumb takes the current text
 *  color, so `className="text-plane-coronal"` tints it per view. */
export function Slider({
  className,
  'aria-label': ariaLabel,
  size = 'sm',
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { size?: 'sm' | 'lg' }) {
  const lg = size === 'lg'; // phone: a thumb big enough for a finger
  return (
    <SliderPrimitive.Root
      className={cn('relative flex w-full touch-none select-none items-center', lg ? 'h-11' : 'h-5', className)}
      {...props}
    >
      <SliderPrimitive.Track className={cn('relative w-full grow overflow-hidden rounded-full bg-border-strong', lg ? 'h-1.5' : 'h-1')}>
        <SliderPrimitive.Range className="absolute h-full bg-current opacity-40" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        className={cn(lg ? 'size-6 border-[3px]' : 'size-3.5 border-2', 'block rounded-full border-surface bg-current shadow-[0_0_0_1px_currentColor] transition-transform hover:scale-110')}
      />
    </SliderPrimitive.Root>
  );
}
