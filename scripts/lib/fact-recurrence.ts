/** #11083: cheap warning heuristic, never proof of duplication or automatic removal.
 * Shared distinctive entities plus incident terms; a follow-up still needs editorial judgment.
 * Past titles/themes are independent evidence, never one combined edition bag.
 *
 * #11109: 1 entidade comum qualquer não basta. Peso da evidência = soma das
 * entidades compartilhadas, onde entidade FORTE (sigla toda em maiúsculas, ex.
 * PHP/CVE, ou com dígito, ex. GPT-5) vale 2 e entidade comum (Microsoft, Teams)
 * vale 1; o aviso exige peso >= 2 (`FACT_RECURRENCE_MIN_WEIGHT`). Do lado do
 * item (no Stage 4 é o parágrafo inteiro), a palavra que abre cada frase é
 * ignorada, a não ser que seja forte: "Segundo", "Pesquisadores", "Estudo" ou
 * "Microsoft corrige..." deixam de virar entidade só por abrir a frase. O lado
 * do passado (título curto da edição) não sofre esse filtro, porque o título
 * costuma começar justamente pela entidade principal.
 */
import { editionDaysBefore } from './event-dedup.ts';
export const FACT_RECURRENCE_MIN_WEIGHT = 2;
/** score = min(1, 0.5 + 0.25 * peso); peso 2 => 1.0, peso 1 => 0.75. */
export const FACT_RECURRENCE_THRESHOLD = 1;
export interface FactItem { title: string; summary?: string; url: string; kind?: string }
const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const STOP = new Set(['ia', 'ai', 'the', 'uma', 'para', 'como', 'com', 'new', 'novo', 'nova', 'google', 'openai', 'meta', 'anthropic', 'claude', 'chatgpt', 'eua', 'usa']);
const ENTITY_RE = /\b[A-Z][A-Za-z0-9-]{2,}\b/g;
/** Sigla toda em maiúsculas (PHP, CVE) ou token com dígito (GPT-5, CVE-2026). */
function isStrong(raw: string): boolean {
  return /\d/.test(raw) || raw === raw.toUpperCase();
}
function entities(s: string, skipSentenceStart = false): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const segments = skipSentenceStart ? s.split(/(?<=[.!?:;])\s+|\n+/) : [s];
  for (const seg of segments) {
    // Posição da 1ª letra/dígito do segmento, pulando pontuação/markdown na frente ([, **, #, aspas).
    const start = skipSentenceStart ? seg.search(/[\p{L}\p{N}]/u) : -1;
    for (const m of seg.matchAll(ENTITY_RE)) {
      const raw = m[0];
      if (m.index === start && !isStrong(raw)) continue;
      const key = normalize(raw);
      if (STOP.has(key) || incident(key)) continue;
      out.set(key, (out.get(key) ?? false) || isStrong(raw));
    }
  }
  return out;
}
function incident(s: string): boolean {
  return /\b(falha\w*|vulnerab\w*|hack\w*|breach\w*|ataque\w*|rce|apagao|security|seguranca|ciber\w*|cyber\w*)\b/.test(normalize(s));
}
export function findFactRecurrences(items: FactItem[], pastMd: string, edition: string) {
  const warnings: Array<{ item_title: string; item_url: string; kind?: string; matched_edition: string; matched_title: string; score: number; shared_entities: string[]; possible_new_fact: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.url)) continue;
    const text = `${item.title}\n${item.summary ?? ''}`;
    if (!incident(text)) continue;
    const names = entities(text, true);
    for (const part of pastMd.split(/\n(?=## \d{4}-)/)) {
      const header = part.match(/^## (\d{4})-(\d{2})-(\d{2})[^\n]*?"(.+)"/m);
      if (!header) continue;
      const previous = header[1].slice(2) + header[2] + header[3];
      const days = editionDaysBefore(previous, edition);
      if (days === undefined || days <= 0 || days > 30) continue;
      // Title and individual theme lines retain uppercase entity spelling.
      const evidence = [header[4], ...(part.split('Temas cobertos:')[1]?.split('\n').filter(x => x.startsWith('- ')) ?? [])];
      const match = evidence.filter(title => incident(title)).map(title => {
        const past = entities(title);
        const shared = [...past.keys()].filter(x => names.has(x));
        const weight = shared.reduce((sum, x) => sum + (past.get(x) || names.get(x) ? 2 : 1), 0);
        return { title, shared, weight };
      }).find(x => x.weight >= FACT_RECURRENCE_MIN_WEIGHT);
      if (!match) continue;
      const score = Math.min(1, 0.5 + 0.25 * match.weight);
      if (score < FACT_RECURRENCE_THRESHOLD) continue;
      seen.add(item.url);
      warnings.push({ item_title: item.title, item_url: item.url, kind: item.kind, matched_edition: previous, matched_title: match.title, score, shared_entities: match.shared,
        possible_new_fact: item.summary ? `Resumo a conferir como possível fato novo: ${item.summary}` : 'Fato novo não demonstrado no título; conferir a fonte.' });
      break;
    }
  }
  return warnings;
}
