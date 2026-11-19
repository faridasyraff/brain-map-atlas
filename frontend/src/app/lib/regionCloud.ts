// "Semantic Region Map": when the assistant answers with a list of regions,
// pull the names out of the text and resolve each to an atlas region, so they
// become clickable chips. Ported from the original chatPanel.js.
import { resolveRegionName, type SearchResult } from './api';

const NON_REGION_WORDS = new Set([
  'function', 'connectivity', 'overview', 'summary', 'note', 'notes', 'description', 'introduction',
  'background', 'context', 'clinical', 'relevance', 'anatomy', 'structure', 'substructure', 'division',
  'category', 'organ', 'region', 'area', 'pathway', 'circuit', 'system', 'network', 'projection', 'input',
  'output', 'afferent', 'efferent', 'axon', 'neuron', 'yes', 'no', 'also', 'here', 'these', 'those', 'this',
  'that', 'the', 'and', 'associated', 'related', 'connected', 'involved', 'including', 'such', 'important',
  'major', 'key', 'primary', 'secondary', 'main', 'central', 'role', 'part', 'side', 'left', 'right', 'layer',
  'layers', 'regions', 'areas', 'pathways', 'circuits', 'systems', 'nuclei', 'nucleus',
]);

const clean = (n: string) =>
  n
    .replace(/\*\*/g, '')
    .replace(/[_`*]/g, '')
    .replace(/\s*[:([].*/, '')
    .replace(/[,;.!?]+$/, '')
    .trim()
    // "The Retrosplenial Area" -> "Retrosplenial Area" (the original version
    // rejected the whole phrase because it started with an article).
    .replace(/^(the|a|an)\s+/i, '');

const looksLikeRegion = (n: string) =>
  n.length >= 3 &&
  n.length <= 60 &&
  !NON_REGION_WORDS.has(n.toLowerCase()) &&
  !/^(the |a |an |of |in |for |to |with |by |from |and |or )/i.test(n) &&
  !/\b(process|involve|play|send|receive|project|connect|control|regulate|modulat|integrat|includ|compris)\b/i.test(n);

/** Candidate region names in an answer: list items, **bold**, "quoted", Capitalised Multi Words. */
export function extractCandidateNames(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const n = clean(raw);
    if (looksLikeRegion(n)) out.add(n);
  };
  for (const line of text.split('\n')) {
    add(line.match(/^\s*(?:\d+[.)]\s*|[-*•]\s+)(.+)/)?.[1]);
    for (const m of line.matchAll(/\*{1,2}([A-Z][^*]{2,55})\*{1,2}/g)) add(m[1]);
    for (const m of line.matchAll(/["']([A-Z][^"']{2,55})["']/g)) add(m[1]);
    for (const m of line.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})\b/g)) add(m[1]);
  }
  return [...out];
}

/** Whether a question is asking for a list of regions (only then is a map worth building). */
export function isListQuery(q: string): boolean {
  return (
    /\b(list|enumerate|what\s+are|which\s+are|name\s+(all|the)|give\s+me|show\s+me)\b.*(region|area|structure|nucleus|nuclei|part|subdivision|connected|projection|input|output)/i.test(q) ||
    /\b(region|area|structure|nucleus|nuclei|subdivision)s?\s+(of|in|for|connected|related|involved|associated)/i.test(q) ||
    /\bconnected\s+to\b|\bprojects?\s+to\b|\binput.*from\b|\boutput.*to\b/i.test(q)
  );
}

/** Resolve a candidate name: as written, without "(…)", then by its first two words. */
export async function resolveCandidate(name: string): Promise<SearchResult | null> {
  const tries = [name];
  const stripped = name.replace(/\s*\([^)]*\)/, '').trim();
  if (stripped !== name && stripped.length >= 3) tries.push(stripped);
  const words = stripped.split(/\s+/);
  if (words.length >= 3) tries.push(words.slice(0, 2).join(' '));
  for (const t of tries) {
    const r = await resolveRegionName(t).catch(() => null);
    if (r) return r;
  }
  return null;
}
