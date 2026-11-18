import { Button } from '@/components/ui/button';

/** The React app. Stage 1 of the migration: tooling only. The atlas shell,
 *  panels and viewers move in over the next stages; until then this page
 *  points to the current app. */
export function App() {
  return (
    <main className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <h1 className="text-xl font-semibold">Brain Atlas Explorer</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The React version is being built here. The current atlas is still the one to use.
        </p>
        <div className="mt-5 flex gap-2">
          <Button asChild variant="primary">
            <a href="/app">Open the atlas</a>
          </Button>
          <Button asChild variant="ghost">
            <a href="/">Home</a>
          </Button>
        </div>
      </div>
    </main>
  );
}
