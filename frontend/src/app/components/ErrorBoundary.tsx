import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  /** What broke, in the user's words ("the assistant"). */
  area: string;
  children: ReactNode;
  className?: string;
}

/**
 * Contains a rendering crash to one part of the page. Without this, any
 * uncaught error unmounts the whole React tree and the user is left with a
 * blank screen.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.area}]`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className={this.props.className ?? 'p-5'}>
        <p className="text-sm font-semibold text-destructive">Something went wrong in {this.props.area}.</p>
        <p className="mt-1 text-sm text-muted-foreground">The rest of the atlas still works.</p>
        <Button size="sm" className="mt-3" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
