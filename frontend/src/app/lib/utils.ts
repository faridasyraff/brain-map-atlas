import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Join class names, letting later Tailwind classes override earlier ones
 *  (`cn('px-2', isWide && 'px-4')` -> 'px-4'). The standard shadcn/ui helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
