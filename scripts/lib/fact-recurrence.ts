/** #11083: cheap warning heuristic, never proof of duplication or automatic removal.
 * Shared distinctive entities plus incident terms; a follow-up still needs editorial judgment.
 * Past titles/themes are independent evidence, never one combined edition bag.
 */
import { editionDaysBefore } from './event-dedup.ts';
export const FACT_RECURRENCE_THRESHOLD = 0.8;
export interface FactItem { title: string; summary?: string; url: string; kind?: string }
const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const STOP = new Set(['ia', 'ai', 'the', 'uma', 'para', 'como', 'com', 'new', 'novo', 'nova', 'google', 'openai', 'meta', 'anthropic', 'claude', 'chatgpt']);
function entities(s: string): Set<string> {
  return new Set((s.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/g) ?? []).map(normalize).filter(x => !STOP.has(x) && !incident(x)));
}
function incident(s: string): boolean {
  return /\b(falha\w*|vulnerab\w*|hack\w*|breach\w*|ataque\w*|rce|apagao|security|seguranca|ciber\w*|cyber\w*)\b/.test(normalize(s));
}
export function findFactRecurrences(items: FactItem[], pastMd: string, edition: string) {
  const warnings: Array<{ item_title: string; item_url: string; kind?: string; matched_edition: string; matched_title: string; score: number; shared_entities: string[]; possible_new_fact: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.url)) continue;
    const text = `${item.title} ${item.summary ?? ''}`;
    const names = entities(text);
    if (!incident(text)) continue;
    for (const part of pastMd.split(/\n(?=## \d{4}-)/)) {
      const header = part.match(/^## (\d{4})-(\d{2})-(\d{2})[^\n]*?"(.+)"/m);
      if (!header) continue;
      const previous = header[1].slice(2) + header[2] + header[3];
      const days = editionDaysBefore(previous, edition);
      if (days === undefined || days <= 0 || days > 30) continue;
      // Title and individual theme lines retain uppercase entity spelling.
      const evidence = [header[4], ...(part.split('Temas cobertos:')[1]?.split('\n').filter(x => x.startsWith('- ')) ?? [])];
      const match = evidence.map(title => ({ title, shared: [...entities(title)].filter(x => names.has(x)) }))
        .find(x => x.shared.length > 0 && incident(x.title));
      if (!match) continue;
      const score = Math.min(1, 0.6 + 0.2 * match.shared.length);
      if (score < FACT_RECURRENCE_THRESHOLD) continue;
      seen.add(item.url);
      warnings.push({ item_title: item.title, item_url: item.url, kind: item.kind, matched_edition: previous, matched_title: match.title, score, shared_entities: match.shared,
        possible_new_fact: item.summary ? `Resumo a conferir como possível fato novo: ${item.summary}` : 'Fato novo não demonstrado no título; conferir a fonte.' });
      break;
    }
  }
  return warnings;
}
