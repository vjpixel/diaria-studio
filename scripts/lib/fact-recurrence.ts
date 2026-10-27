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
import { canonicalize } from './url-utils.ts';
import { isTitleCase } from './title-case.ts'; // #11218: fonte única
export const FACT_RECURRENCE_MIN_WEIGHT = 2;
/** score = min(1, 0.5 + 0.25 * peso); peso 2 => 1.0, peso 1 => 0.75. */
export const FACT_RECURRENCE_THRESHOLD = 1;
export interface FactItem { title: string; summary?: string; url: string; kind?: string }
const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const STOP = new Set(['ia', 'ai', 'the', 'uma', 'para', 'como', 'com', 'new', 'novo', 'nova', 'google', 'openai', 'meta', 'anthropic', 'claude', 'chatgpt', 'eua', 'usa']);
/**
 * #11163: siglas genéricas do vocabulário de tecnologia. Toda em maiúsculas,
 * cada uma valeria 2 pontos (`isStrong`) e atingiria sozinha
 * `FACT_RECURRENCE_MIN_WEIGHT` — "API" num item de segurança e "API" num
 * título de incidente de 20 dias atrás não são o mesmo fato. Não identificam
 * o fato, então não contam como entidade (nem forte, nem comum). Comparadas
 * pela forma normalizada (minúscula, sem acento).
 */
const GENERIC_ACRONYMS = new Set([
  'api', 'apis', 'sdk', 'sdks', 'app', 'apps', 'saas', 'url', 'urls', 'http', 'https', 'html', 'json', 'pdf', 'faq',
  'ceo', 'ceos', 'cto', 'cfo', 'coo', 'ong', 'ongs',
  'llm', 'llms', 'gpu', 'gpus', 'cpu', 'cpus', 'tpu', 'tpus', 'npu', 'ram', 'ssd', 'usb', 'vpn', 'dns', 'sms', 'agi',
  'aws',
]);
const ENTITY_RE = /\b[A-Z][A-Za-z0-9-]{2,}\b/g;
/** Sigla toda em maiúsculas (PHP, CVE) ou token com dígito (GPT-5, CVE-2026). */
function isStrong(raw: string): boolean {
  return /\d/.test(raw) || raw === raw.toUpperCase();
}
function entities(s: string, skipSentenceStart = false, stop: Set<string> = STOP): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const segments = skipSentenceStart ? s.split(/(?<=[.!?:;])\s+|\n+/) : [s];
  for (const seg of segments) {
    // Posição da 1ª letra/dígito do segmento, pulando pontuação/markdown na frente ([, **, #, aspas).
    const start = skipSentenceStart ? seg.search(/[\p{L}\p{N}]/u) : -1;
    for (const m of seg.matchAll(ENTITY_RE)) {
      const raw = m[0];
      if (m.index === start && !isStrong(raw)) continue;
      const key = normalize(raw);
      if (stop.has(key) || GENERIC_ACRONYMS.has(key) || incident(key)) continue;
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

// ---------------------------------------------------------------------------
// #11173: MESMA HISTÓRIA dentro da própria edição (pool × destaque, pool × pool)
// ---------------------------------------------------------------------------

/**
 * Item da edição corrente para a comparação intra-edição. `title` é a manchete
 * (entidades contadas sem o filtro de início de frase: a manchete costuma abrir
 * pela entidade principal, "Android ganha..."); `summary` é o resto do texto
 * (resumo do pool, ou corpo do destaque), com o filtro de início de frase do
 * #11109. `label` nomeia o item na mensagem (ex. "D1", "RADAR").
 */
export interface IntraEditionItem { title: string; summary?: string; url: string; label: string }

export interface IntraEditionWarning {
  item_label: string;
  item_title: string;
  item_url: string;
  matched_label: string;
  matched_title: string;
  matched_url: string;
  /** Entidades em comum no TEXTO dos dois lados (normalizadas). */
  shared_entities: string[];
  /** Entidade de um lado que só aparece no slug da URL do outro (#11173, caso Android × Circle to Search). */
  url_entities: string[];
  weight: number;
}

/**
 * Peso mínimo intra-edição. Mesmo valor do aviso entre edições (#11109): uma
 * sigla/termo com dígito em comum (PHP, PHP2Shell, CVE-…), ou 2 entidades
 * comuns. A entidade que só aparece no slug da URL do outro lado vale 1.
 */
export const INTRA_EDITION_MIN_WEIGHT = 2;

/**
 * Termos de golpe/fraude: no mesmo dia, "Android barra mensagens falsas e
 * golpes" e "Circle to Search checa se o SMS é scam" são a mesma rodada de
 * anúncios do Google. Só valem intra-edição — o aviso entre edições (#11083)
 * segue restrito a incidente de segurança, porque "golpe" sozinho atravessa
 * 30 dias de pauta sem identificar um fato.
 */
function scam(s: string): boolean {
  return /\b(golpe\w*|golpista\w*|scam\w*|fraud\w*|phishing|mensagens? falsas?|chamadas? falsas?)\b/.test(normalize(s));
}
const intraIncident = (s: string) => incident(s) || scam(s);

/**
 * Stop list intra-edição. Diferente do `STOP` entre edições em dois pontos:
 * (1) as big techs (Google, OpenAI, Meta…) CONTAM como entidade comum (peso 1) —
 * no mesmo dia, "Google" + outra entidade em comum + incidente é a mesma rodada
 * de anúncios, enquanto em 30 dias de pauta "Google" não identifica nada;
 * (2) palavras funcionais EN/PT, que manchete em Title Case ("What It Means For
 * You") faz parecer entidade.
 */
const INTRA_STOP = new Set([
  'ia', 'ai', 'the', 'uma', 'para', 'como', 'com', 'new', 'novo', 'nova', 'eua', 'usa',
  'and', 'for', 'what', 'that', 'this', 'with', 'from', 'how', 'why', 'who', 'you', 'your', 'its', 'are', 'was',
  'has', 'have', 'will', 'not', 'but', 'our', 'can', 'all', 'now', 'get', 'out', 'into', 'over', 'after', 'about',
  'apos', 'sobre', 'mais', 'entre', 'pela', 'pelo', 'isso', 'este', 'esta', 'veja', 'entenda', 'saiba',
  // "Inteligência Artificial" capitalizado e o país da própria newsletter não identificam história.
  'inteligencia', 'artificial', 'intelligence', 'brasil', 'brazil',
]);

/** Tokens do slug da URL (path), normalizados, ≥3 letras. */
function urlTokens(url: string): Set<string> {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* URL relativa ou inválida: usa a string inteira */ }
  return new Set(normalize(path).split(/[^a-z0-9]+/).filter(t => t.length >= 3));
}

function itemEntities(it: IntraEditionItem): Map<string, boolean> {
  const fromSummary = entities(it.summary ?? '', true, INTRA_STOP);
  const fromTitle = entities(it.title, false, INTRA_STOP);
  const out = new Map(fromSummary);
  const titleCase = isTitleCase(it.title);
  for (const [k, strong] of fromTitle) {
    // Title Case: só vale a sigla/termo com dígito, ou a palavra que o resumo também trata como nome.
    if (titleCase && !strong && !fromSummary.has(k)) continue;
    out.set(k, (out.get(k) ?? false) || strong);
  }
  return out;
}

/**
 * #11173: item do pool (LANÇAMENTOS/USE MELHOR/RADAR) que conta a mesma
 * história de um destaque DA MESMA edição, ou de outro item do pool anterior a
 * ele. Casos reais: 261023 (Canaltech e G1 sobre a falha no PHP no pool, com o
 * D1 da Wiz sobre o PHP2Shell) e 261016 (Canaltech "Android ganha
 * superproteção… barra mensagens falsas" × "Check if a text message is a scam
 * using Circle to Search" do blog do Google). O dedup intra-edição
 * (`dedup-intra-edition.ts`) não junta os pares porque o vocabulário EN×PT é
 * quase disjunto e ignora entidades de 3 letras ("PHP"); o MESMO FATO
 * (`same-fact-check.ts`) exige produto com versão.
 *
 * Regra: os dois lados com termo de incidente/golpe, e peso de entidades em
 * comum ≥ `INTRA_EDITION_MIN_WEIGHT` (sigla/termo com dígito = 2, entidade
 * comum = 1, entidade presente só no slug da URL do outro lado = 1). Mesma URL
 * canônica é pulada (espelho do destaque no pool não é história repetida, é
 * trabalho do dedup por URL). 1 aviso por item do pool: destaque antes de pool.
 *
 * Só aviso, nunca remove: corte no gate 4 é barato, inclusão errada não é
 * (meta de 10 itens), e a régua do corpus mostra desdobramentos legítimos com a
 * mesma entidade (Guardian analisando a "nova era" de ataques após o PHP).
 */
export function findIntraEditionFactRecurrences(highlights: IntraEditionItem[], pool: IntraEditionItem[]): IntraEditionWarning[] {
  type Prepared = { it: IntraEditionItem; incident: boolean; names: Map<string, boolean>; slug: Set<string>; url: string };
  const prep = (it: IntraEditionItem): Prepared => ({
    it,
    incident: intraIncident(`${it.title}\n${it.summary ?? ''}`),
    names: itemEntities(it),
    slug: urlTokens(it.url),
    url: canonicalize(it.url),
  });
  const compare = (a: Prepared, b: Prepared) => {
    const shared = [...a.names.keys()].filter(x => b.names.has(x));
    const viaUrl = [
      ...[...a.names.keys()].filter(x => !b.names.has(x) && b.slug.has(x)),
      ...[...b.names.keys()].filter(x => !a.names.has(x) && a.slug.has(x)),
    ];
    const weight = shared.reduce((sum, x) => sum + (a.names.get(x) || b.names.get(x) ? 2 : 1), 0) + viaUrl.length;
    return { shared, viaUrl: [...new Set(viaUrl)], weight };
  };
  // Espelho do destaque no pool (mesma URL canônica — no 01-approved.json o D1
  // de 261023 traz a manchete em PT sem "PHP", e o espelho no RADAR traz a
  // manchete original da Wiz, "PHP2Shell: …"): o texto do espelho soma ao do
  // destaque, e o espelho em si não é comparado.
  const hlUrls = new Set(highlights.map(h => canonicalize(h.url)));
  const hs = highlights.map(h => {
    const mirrors = pool.filter(p => canonicalize(p.url) === canonicalize(h.url));
    return prep({ ...h, summary: [h.summary ?? '', ...mirrors.map(m => `${m.title}. ${m.summary ?? ''}`)].join('\n') });
  }).filter(h => h.incident);
  const seenPool: Prepared[] = [];
  const warnings: IntraEditionWarning[] = [];
  for (const raw of pool) {
    if (hlUrls.has(canonicalize(raw.url))) continue;
    const p = prep(raw);
    if (p.incident) {
      for (const other of [...hs, ...seenPool]) {
        if (other.url === p.url) continue;
        const { shared, viaUrl, weight } = compare(p, other);
        if (weight < INTRA_EDITION_MIN_WEIGHT) continue;
        warnings.push({
          item_label: raw.label, item_title: raw.title, item_url: raw.url,
          matched_label: other.it.label, matched_title: other.it.title, matched_url: other.it.url,
          shared_entities: shared.sort(), url_entities: viaUrl.sort(), weight,
        });
        break;
      }
      seenPool.push(p);
    }
  }
  return warnings;
}
