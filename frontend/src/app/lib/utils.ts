import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Our own `animate-*` names (globals.css), so a later one replaces an earlier
// one: the phone sheet's slide-up wins over the dialog's default fade.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { animate: ['fade-in', 'fade-out', 'dialog-in', 'dialog-out', 'sheet-in', 'sheet-out', 'tooltip-in'] },
  },
});

/** Join class names, letting later Tailwind classes override earlier ones
 *  (`cn('px-2', isWide && 'px-4')` -> 'px-4'). The standard shadcn/ui helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
