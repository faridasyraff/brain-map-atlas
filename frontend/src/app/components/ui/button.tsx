import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui-style button, themed with the app's tokens (see globals.css).
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
    'transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-white',
        secondary: 'border border-border-strong bg-raised text-foreground hover:bg-hover',
        ghost: 'text-muted-foreground hover:bg-hover hover:text-foreground',
        danger: 'border border-destructive text-destructive hover:bg-destructive/10',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9 px-3.5 text-sm',
        lg: 'h-12 px-6 text-base',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. an <a>) with button styling instead of a <button>. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      // A plain <button> defaults to type="submit"; make that opt-in.
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}
