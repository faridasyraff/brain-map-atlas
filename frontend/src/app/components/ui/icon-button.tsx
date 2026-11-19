import * as Tooltip from '@radix-ui/react-tooltip';
import { Button, type ButtonProps } from './button';

/** An icon-only button. `label` is both its accessible name and the hover/focus tooltip. */
export function IconButton({ label, children, ...props }: ButtonProps & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} {...props}>
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          // Grows out of its trigger on the first, delayed open; later ones (instant-open) just appear.
          className="z-50 origin-(--radix-tooltip-content-transform-origin) rounded-md bg-raised px-2 py-1 text-xs text-foreground shadow-menu data-[state=delayed-open]:animate-tooltip-in"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Wrap the app once so tooltips share timing (a quick re-hover shows instantly). */
export const TooltipProvider = Tooltip.Provider;
