import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';
import { cn } from '@/lib/utils';

describe('Button', () => {
  it('is a non-submitting button by default', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('calls onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders its child instead with asChild (e.g. a link styled as a button)', () => {
    render(
      <Button asChild variant="primary">
        <a href="/app">Open the atlas</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open the atlas' });
    expect(link).toHaveAttribute('href', '/app');
    expect(link).not.toHaveAttribute('type');
    expect(link.className).toContain('bg-primary');
  });
});

describe('cn', () => {
  it('lets later Tailwind classes win', () => {
    expect(cn('px-2 text-sm', false && 'hidden', 'px-4')).toBe('text-sm px-4');
  });
});
