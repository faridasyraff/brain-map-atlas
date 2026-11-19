import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { askAssistant, type AiProvider, type ChatReply, type SearchResult } from '@/lib/api';
import { openSearchResult } from '@/lib/navigate';
import { extractCandidateNames, isListQuery, resolveCandidate } from '@/lib/regionCloud';
import { isHexColor } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { useAtlas } from '@/store/atlas';

type Message =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'bot'; reply: ChatReply; question: string };

/** Q&A about the selected region, via the local model (Ollama) or GPT. */
export function Assistant() {
  const selection = useAtlas((s) => s.selection);
  const [provider, setProvider] = useState<AiProvider>('ollama');
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (question: string) =>
      askAssistant({
        message: question,
        provider,
        regionName: selection?.label,
        regionAcronym: selection?.acronym,
        pidx: selection?.pidx,
      }),
  });

  // Block body on purpose: in current Chrome scrollIntoView() returns a Promise,
  // and an effect must return nothing or a cleanup function (React throws otherwise).
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, ask.isPending]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q || ask.isPending) return;
    setText('');
    setMessages((m) => [...m, { id: nextId.current++, role: 'user', text: q }]);
    ask.mutate(q, {
      onSuccess: (reply) => setMessages((m) => [...m, { id: nextId.current++, role: 'bot', reply, question: q }]),
      onError: (err) =>
        setMessages((m) => [
          ...m,
          { id: nextId.current++, role: 'bot', question: q, reply: { answer: `Something went wrong: ${err.message}`, provider } },
        ]),
    });
  }

  return (
    <section aria-label="Assistant" className="flex min-h-0 flex-[2_1_0] flex-col border-t border-border">
      <header className="flex items-center justify-between px-5 pb-2 pt-3">
        <h2 className="text-sm font-semibold">Assistant</h2>
        <div role="group" aria-label="AI model" className="flex gap-0.5 rounded-md border border-border bg-background p-0.5">
          {(
            [
              ['ollama', 'Local', 'Runs on your own computer with Ollama'],
              ['openai', 'GPT', 'OpenAI GPT-4o mini (needs an API key)'],
            ] as const
          ).map(([id, label, title]) => (
            <button
              key={id}
              type="button"
              title={title}
              aria-pressed={provider === id}
              onClick={() => setProvider(id)}
              className={cn(
                'h-6 rounded-sm px-2.5 text-xs font-medium text-muted-foreground',
                provider === id && 'bg-hover text-foreground shadow-[0_0_0_1px_var(--color-border-strong)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-2">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {selection ? `Ask about ${selection.label}: its function, connections or anatomy.` : 'Select a region, then ask about it, or ask a general question.'}
          </p>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <p key={m.id} className="max-w-[85%] self-end rounded-[12px_12px_4px_12px] bg-raised px-3 py-2 text-sm">
              {m.text}
            </p>
          ) : (
            <BotMessage key={m.id} reply={m.reply} question={m.question} />
          ),
        )}
        {ask.isPending && <p className="text-sm text-muted-foreground">Thinking…</p>}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="flex gap-2 px-5 pb-4 pt-2">
        <label htmlFor="assistant-input" className="sr-only">
          Question for the assistant
        </label>
        <Input id="assistant-input" autoComplete="off" placeholder="Ask about the selected region" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!text.trim() || ask.isPending}>
          Ask
        </Button>
      </form>
    </section>
  );
}

function BotMessage({ reply, question }: { reply: ChatReply; question: string }) {
  const sources = (reply.pmc_sources ?? []).filter((id) => /^PMC\d+$/i.test(id));
  return (
    <div className="max-w-[95%] self-start text-sm leading-relaxed">
      <span className="mr-1.5 rounded-sm border border-border-strong px-1.5 text-[11px] text-muted-foreground">
        {reply.provider === 'openai' ? 'GPT' : 'Local'}
      </span>
      {/* Rendered as text (React escapes it), never as HTML. */}
      <span className="whitespace-pre-line">{reply.answer}</span>
      {reply.cortexmap_notice && (
        <p className="mt-2 rounded-r-sm border-l-2 border-warning bg-raised px-3 py-2 text-xs text-muted-foreground">{reply.cortexmap_notice}</p>
      )}
      {sources.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="w-full">Sources (PubMed Central):</span>
          {sources.map((id) => (
            <a key={id} href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${encodeURIComponent(id)}/`} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
              {id}
            </a>
          ))}
        </p>
      )}
      {isListQuery(question) && <RegionMap answer={reply.answer} />}
    </div>
  );
}

/** Clickable chips for the regions named in a list-style answer. */
function RegionMap({ answer }: { answer: string }) {
  const [items, setItems] = useState<{ name: string; result: SearchResult | null | undefined }[]>(() =>
    extractCandidateNames(answer).map((name) => ({ name, result: undefined })),
  );
  useEffect(() => {
    let alive = true;
    items.forEach((it, i) =>
      void resolveCandidate(it.name).then((result) => {
        if (alive) setItems((cur) => cur.map((c, j) => (j === i ? { ...c, result } : c)));
      }),
    );
    return () => {
      alive = false;
    };
    // Resolve once per answer.
  }, [answer]);

  if (items.length < 2) return null;
  const found = items.filter((i) => i.result).length;
  const done = items.every((i) => i.result !== undefined);
  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3">
      <p className="mb-2 flex justify-between text-xs">
        <span className="font-semibold">Regions in this answer</span>
        <span className="text-subtle-foreground">{done ? `${found} of ${items.length} in the atlas` : 'Looking them up…'}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(({ name, result }) => (
          <button
            key={name}
            type="button"
            disabled={!result}
            onClick={() => result && void openSearchResult(result)}
            title={result === null ? 'Not found in the atlas' : undefined}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border border-border-strong px-3 text-xs',
              result ? 'hover:bg-hover' : 'opacity-55',
            )}
          >
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: isHexColor(result?.structure_color) ? result.structure_color : 'var(--color-subtle-foreground)' }} />
            {result ? (result.group_name ?? result.matched_label) : name}
          </button>
        ))}
      </div>
    </div>
  );
}
