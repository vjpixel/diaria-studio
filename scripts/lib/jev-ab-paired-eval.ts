/**
 * jev-ab-paired-eval.ts (#9531 — decide o A/B do #8421, epic #8412)
 *
 * Avaliação PAREADA e RETROATIVA por decisão: para cada edição, roda a lógica
 * baseline e a lógica Jev sobre as MESMAS entradas do Stage 1 e só olha os
 * casos em que as duas divergem. Elimina o confundimento por época/modelo que
 * as métricas de edição inteira do `jev-ab-report.ts` sofrem (o efeito do Jev
 * é local a 2 decisões do Stage 1; correções do gate 4/tokens/wall-clock têm
 * ruído muito maior).
 *
 * Duas decisões (as únicas que o perfil B muda — `_internal/.jev-profile.json`):
 *
 *  1. Dedup zona cinzenta (Pass 1c de `scripts/dedup.ts`): baseline =
 *     Jaccard + `thresholdForPair` (0.60, ou 0.55 com entidade compartilhada);
 *     Jev = `dedup-grayzone-jev.ts` em modo ATIVO (decide quando
 *     `confidence >= GRAYZONE_MIN_CONFIDENCE`, só na zona `[0.35, 0.85)`, só
 *     nos até `GRAYZONE_MAX_PAIRS` pares que `collectGrayZonePairs` escolhe).
 *     A divergência é medida no nível do ARTIGO (o que de fato muda a
 *     edição): o artigo cai se QUALQUER par com título passado decidir
 *     "mesma história".
 *
 *  2. Brasil (`actor_brazil`): baseline = `detectBrazil()`; Jev =
 *     `brazil_p >= JEV_BRAZIL_THRESHOLD`. Só informativo: nenhuma decisão do
 *     pipeline diário consome `brazil_p`.
 *
 * Gabarito (nunca chutado): o editor só "vota" sobre o que chegou até ele.
 * Artigo divergente cuja URL está em `02-reviewed.md` (`publicado`) ou só em
 * `01-approved.json` (`aprovado`) → o editor MANTEVE → a resposta certa é
 * "não é repetição". Qualquer outro caso → `sem_gabarito`.
 *
 * VIÉS DE SOBREVIVÊNCIA (achado do review da PR, não escondido): o gabarito
 * só existe para o que sobreviveu ao dedup que RODOU AO VIVO naquela edição.
 *   - Braço A (baseline ao vivo): só "Jev descarta / baseline mantém" ganha
 *     gabarito → mede FALSO DESCARTE do Jev (erro grave b), nunca acerto.
 *   - Braço B (Jev ao vivo): só "Jev mantém / baseline descarta" ganha
 *     gabarito → mede ACERTO do Jev; os falsos descartes do Jev ali ficam
 *     invisíveis (b subcontado no B).
 * Por isso o critério (a) (acerto Jev > baseline) NÃO é comparável somando os
 * braços — `decide()` o declara "não demonstrável" e a decisão se apoia em
 * (b), que no braço A é contrafactual válido (o editor publicou/aprovou de
 * fato um item que o Jev teria descartado). A outra metade de (b) — "deixar
 * passar repetição real" — não tem gabarito derivável e não é medida.
 *
 * Tudo aqui é puro (sem rede, sem fs) — I/O e chamadas Jev ficam no CLI
 * `scripts/jev-ab-paired-eval.ts`.
 */

import { jaccardSimilarity, thresholdForPair, tokenizeForJaccard } from "./title-similarity.ts";
import {
  GRAYZONE_MIN_CONFIDENCE,
  collectGrayZonePairs,
  inGrayZone,
  pairKey,
  type GrayZonePair,
  type GrayZoneVerdict,
} from "./dedup-grayzone-jev.ts";

// ---------------------------------------------------------------------------
// Constantes (espelham os defaults de produção — ver dedup.ts / collect-monthly.ts)
// ---------------------------------------------------------------------------

/** Default `--subject-vs-past-threshold` de `scripts/dedup.ts`. */
export const SUBJECT_VS_PAST_THRESHOLD = 0.6;
/** Default `--subject-vs-past-threshold-lowered` de `scripts/dedup.ts` (#1331). */
export const SUBJECT_VS_PAST_THRESHOLD_LOWERED = 0.55;
/** Preço público do Jev (docs/jev.md): US$ 0,042 / 1M tokens de entrada, saída grátis. */
export const JEV_USD_PER_MTOK_INPUT = 0.042;
/** Heurística de tokens por caractere — o cliente `askJev` descarta o `usage` que a API devolve. */
export const CHARS_PER_TOKEN = 4;
/** Abaixo desta fração de pares com veredito Jev o resultado é `inconclusivo` (falha silenciosa viraria "sem divergência"). */
export const MIN_JEV_COVERAGE = 0.9;

// Regra de decisão pré-registrada na #9531 (antes de ver o resultado).
export const RULE_MAX_USD_PER_EDITION = 1;
export const RULE_INDIFFERENT_MAX_DIVERGENCES_PER_EDITION = 1;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface PoolArticle {
  url: string;
  title: string;
  summary: string;
  source: string;
}

export interface DedupPairEval {
  past: string;
  jaccard: number;
  threshold: number;
  heuristicSame: boolean;
  /** Veredito Jev do par (ausente fora da zona, fora do teto ou se a chamada falhou). */
  verdict?: GrayZoneVerdict;
  /** Decisão efetiva do perfil Jev (ativo) neste par. */
  jevSame: boolean;
}

/**
 * `publicado` = URL em `02-reviewed.md` (o editor publicou); `aprovado` = só em
 * `01-approved.json` (passou o gate 1 mas não saiu — sinal mais fraco: o editor
 * pode tê-lo cortado no Stage 4 justamente por ser repetição). Os dois querem
 * dizer "o editor manteve" pela regra pré-registrada; a leitura estrita só
 * conta `publicado`.
 */
export type Truth = "publicado" | "aprovado" | "sem_gabarito";

export type Arm = "A" | "B" | "unknown";

export interface DedupDivergence {
  url: string;
  title: string;
  baselineDrops: boolean;
  jevDrops: boolean;
  /** Par que decidiu a queda do lado que derruba o artigo. */
  decisivePair: DedupPairEval;
  truth: Truth;
  /** Derivados de `truth` + drops — sempre via `scoreAgainstTruth`, nunca à mão. */
  baselineCorrect: boolean | null;
  jevCorrect: boolean | null;
  /** Jev descartou item que o editor manteve/aprovou — erro grave (b). */
  jevGrave: boolean;
}

export interface BrazilDivergence {
  url: string;
  title: string;
  baseline: boolean;
  brazilP: number;
  jev: boolean;
  truth: "sem_gabarito";
}

export interface EditionEval {
  edition: string;
  arm: Arm;
  poolSize: number;
  grayPairs: number;
  /** Pares acima do teto `GRAYZONE_MAX_PAIRS` (em produção ficam com a heurística). */
  grayPairsTruncated: number;
  jevVerdicts: number;
  /** Vereditos lidos do artefato gravado AO VIVO (`dedup-grayzone-jev.json`, braço B). */
  jevVerdictsRecorded: number;
  dedup: DedupDivergence[];
  brazilItems: number;
  brazilAnnotated: number;
  brazil: BrazilDivergence[];
  jevCalls: number;
  estTokens: number;
  estUsd: number;
  /** Soma do tempo das chamadas Jev que de fato foram à rede (ms) — `null` = nenhuma (tudo cache/artefato). */
  jevWallMs: number | null;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

/** Normalização leve de URL pra casar pool × approved × reviewed. */
export function normalizeUrlForMatch(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/** Achata `_internal/researcher-results.json` (inclui fontes RSS) no pool bruto, dedup por URL. */
export function flattenResearcherPool(results: unknown): PoolArticle[] {
  const out: PoolArticle[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(results)) return out;
  for (const r of results as Array<{ source?: string; articles?: unknown }>) {
    if (!r || !Array.isArray(r.articles)) continue;
    for (const a of r.articles as Array<Record<string, unknown>>) {
      const url = typeof a?.url === "string" ? a.url : "";
      const title = typeof a?.title === "string" ? a.title : "";
      if (!url || !title) continue;
      const key = normalizeUrlForMatch(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url,
        title,
        summary: typeof a.summary === "string" ? a.summary : "",
        source: typeof r.source === "string" ? r.source : "",
      });
    }
  }
  return out;
}

interface ApprovedLike {
  url?: string;
  title?: string;
  summary?: string;
  category?: string;
  brazil_p?: number;
  article?: { url?: string; title?: string; summary?: string; category?: string; brazil_p?: number };
}

/** Mesmos buckets que `readApprovedTitles` lê (novos + legados #1629). */
export const APPROVED_BUCKETS = [
  "highlights", "runners_up", "lancamento", "radar", "use_melhor", "video", "pesquisa", "noticias", "tutorial",
] as const;

export interface ApprovedItem {
  url: string;
  title: string;
  summary: string;
  bucket: string;
  /** Categoria editorial do categorize (ex: `BRASIL`), quando gravada. */
  category: string;
  /** `brazil_p` gravado ao vivo pelo `annotate-actor-brazil` (braço B), quando presente. */
  brazilP?: number;
}

/** Itens de um `01-approved.json`/`01-categorized.json`, dedup por URL (primeiro bucket vence). */
export function approvedItems(doc: unknown): ApprovedItem[] {
  const out: ApprovedItem[] = [];
  if (!doc || typeof doc !== "object") return out;
  const seen = new Set<string>();
  for (const bucket of APPROVED_BUCKETS) {
    const arr = (doc as Record<string, unknown>)[bucket];
    if (!Array.isArray(arr)) continue;
    for (const it of arr as ApprovedLike[]) {
      const src = it?.article?.url ? it.article : it;
      const url = src?.url;
      if (!url) continue;
      const key = normalizeUrlForMatch(url);
      if (seen.has(key)) continue;
      seen.add(key);
      const bp = src?.brazil_p;
      out.push({
        url,
        title: src?.title ?? it?.title ?? "",
        summary: src?.summary ?? "",
        bucket,
        category: src?.category ?? "",
        brazilP: typeof bp === "number" && Number.isFinite(bp) ? bp : undefined,
      });
    }
  }
  return out;
}

/** URLs (normalizadas) citadas num markdown (`02-reviewed.md`). */
export function urlsInMarkdown(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of md.matchAll(/https?:\/\/[^\s)\]>"']+/g)) out.add(normalizeUrlForMatch(m[0]));
  return out;
}

/**
 * As `window` edições estritamente ANTERIORES a `current` (ordem decrescente).
 * Aproximação da janela que o dedup daquela edição viu: o `recentEditionDirs`
 * de produção pega "as mais recentes" no momento da rodada — aplicado
 * retroativamente, vazaria edições futuras.
 */
export function pastWindow(all: string[], current: string, window: number): string[] {
  return [...new Set(all)].filter((d) => d < current).sort().reverse().slice(0, window);
}

/**
 * `defaultWindowDays` do Stage 1, aplicado ao dia em que a pesquisa rodou
 * (D-1 da edição, dia UTC — uma rodada depois das 21h BRT já cai no dia D em
 * UTC e pode ter visto outra janela; aproximação aceita).
 */
export function windowForEdition(aammdd: string): number {
  const y = 2000 + Number(aammdd.slice(0, 2));
  const m = Number(aammdd.slice(2, 4)) - 1;
  const d = Number(aammdd.slice(4, 6));
  const run = new Date(Date.UTC(y, m, d - 1));
  const day = run.getUTCDay();
  return day === 3 || day === 4 || day === 5 ? 3 : 4;
}

/**
 * Vereditos gravados ao vivo pelo braço B (`_internal/dedup-grayzone-jev.json`,
 * `dedup.ts` #8421). Usá-los em vez de reconsultar evita inventar um erro que
 * não aconteceu (a API `noul` não é determinística, docs/jev.md).
 */
export function verdictsFromRecordedArtifact(artifact: unknown): Map<string, GrayZoneVerdict> {
  const out = new Map<string, GrayZoneVerdict>();
  const recs = (artifact as { records?: unknown } | null | undefined)?.records;
  if (!Array.isArray(recs)) return out;
  for (const r of recs as Array<Record<string, unknown>>) {
    if (typeof r?.candidate !== "string" || typeof r?.past !== "string") continue;
    if (typeof r.jevSame !== "boolean" || !isFiniteNum(r.probability) || !isFiniteNum(r.confidence)) continue;
    out.set(pairKey(r.candidate, r.past), { sameStory: r.jevSame, probability: r.probability, confidence: r.confidence });
  }
  return out;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Dedup zona cinzenta
// ---------------------------------------------------------------------------

/**
 * Pares (artigo × título passado) da zona cinzenta que o perfil B de fato
 * consulta — delega em `collectGrayZonePairs` de produção (mesmo teto
 * `GRAYZONE_MAX_PAIRS`, mesma ordem por proximidade do limiar).
 */
export function grayZonePairs(pool: PoolArticle[], pastTitles: string[]): { pairs: GrayZonePair[]; truncated: number } {
  return collectGrayZonePairs(pool, pastTitles);
}

/**
 * Decisão por artigo nas duas lógicas. Pares fora da zona (ou sem veredito)
 * decidem igual nos dois lados (é o que `createGrayZoneResolver` faz em
 * produção); na zona, o Jev decide quando há veredito com confiança suficiente.
 */
export function evaluateDedupArticle(
  article: PoolArticle,
  pastTitles: string[],
  verdicts: Map<string, GrayZoneVerdict>,
  minConfidence = GRAYZONE_MIN_CONFIDENCE,
): { baselineDrops: boolean; jevDrops: boolean; pairs: DedupPairEval[] } {
  const tok = tokenizeForJaccard(article.title);
  const pairs: DedupPairEval[] = [];
  if (tok.size === 0) return { baselineDrops: false, jevDrops: false, pairs };
  for (const past of pastTitles) {
    const sim = jaccardSimilarity(tok, tokenizeForJaccard(past));
    const { threshold } = thresholdForPair(article.title, past, SUBJECT_VS_PAST_THRESHOLD, SUBJECT_VS_PAST_THRESHOLD_LOWERED);
    const heuristicSame = sim >= threshold;
    const verdict = inGrayZone(sim) ? verdicts.get(pairKey(article.title, past)) : undefined;
    const jevSame = verdict && verdict.confidence >= minConfidence ? verdict.sameStory : heuristicSame;
    if (heuristicSame || jevSame || verdict) pairs.push({ past, jaccard: sim, threshold, heuristicSame, verdict, jevSame });
  }
  return {
    baselineDrops: pairs.some((p) => p.heuristicSame),
    jevDrops: pairs.some((p) => p.jevSame),
    pairs,
  };
}

/** Fonte única dos campos derivados do gabarito (usada no rótulo e na leitura estrita). */
export function scoreAgainstTruth(
  truth: Truth,
  baselineDrops: boolean,
  jevDrops: boolean,
): Pick<DedupDivergence, "baselineCorrect" | "jevCorrect" | "jevGrave"> {
  if (truth === "sem_gabarito") return { baselineCorrect: null, jevCorrect: null, jevGrave: false };
  // Gabarito "o editor manteve" → a resposta certa é não descartar.
  return { baselineCorrect: !baselineDrops, jevCorrect: !jevDrops, jevGrave: jevDrops };
}

export function labelDedupDivergence(
  article: PoolArticle,
  ev: { baselineDrops: boolean; jevDrops: boolean; pairs: DedupPairEval[] },
  editorKept: { published: Set<string>; approved: Set<string> },
): DedupDivergence | null {
  if (ev.baselineDrops === ev.jevDrops) return null;
  const decisive = [...ev.pairs]
    .filter((p) => (ev.jevDrops ? p.jevSame && !p.heuristicSame : p.heuristicSame && !p.jevSame))
    .sort((a, b) => b.jaccard - a.jaccard)[0];
  // Divergência implica um par que decide diferente nos dois lados.
  if (!decisive) throw new Error(`divergência sem par decisivo: ${article.url}`);
  const key = normalizeUrlForMatch(article.url);
  const truth: Truth = editorKept.published.has(key) ? "publicado" : editorKept.approved.has(key) ? "aprovado" : "sem_gabarito";
  return {
    url: article.url,
    title: article.title,
    baselineDrops: ev.baselineDrops,
    jevDrops: ev.jevDrops,
    decisivePair: decisive,
    truth,
    ...scoreAgainstTruth(truth, ev.baselineDrops, ev.jevDrops),
  };
}

// ---------------------------------------------------------------------------
// Brasil
// ---------------------------------------------------------------------------

export function brazilDivergence(
  item: { url: string; title: string },
  baseline: boolean,
  brazilP: number | undefined,
  threshold: number,
): BrazilDivergence | null {
  if (typeof brazilP !== "number") return null;
  const jev = brazilP >= threshold;
  if (jev === baseline) return null;
  return { url: item.url, title: item.title, baseline, brazilP, jev, truth: "sem_gabarito" };
}

// ---------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------

/** Tokens de entrada estimados de uma chamada Jev (state + perguntas serializados). */
export function estimateJevTokens(state: unknown, questions: unknown): number {
  return Math.ceil(JSON.stringify({ state, questions }).length / CHARS_PER_TOKEN);
}

export function tokensToUsd(tokens: number): number {
  return (tokens / 1_000_000) * JEV_USD_PER_MTOK_INPUT;
}

// ---------------------------------------------------------------------------
// Agregação + regra de decisão pré-registrada
// ---------------------------------------------------------------------------

export interface ArmStats {
  divergences: number;
  labeled: number;
  jevHits: number;
  baselineHits: number;
  jevGrave: number;
}

export interface Verdict {
  outcome: "adotar" | "nao_adotar" | "indiferente" | "inconclusivo";
  strict: boolean;
  divergencesPerEdition: number;
  labeled: number;
  jevHits: number;
  baselineHits: number;
  jevGrave: number;
  byArm: Record<Arm, ArmStats>;
  jevCoverage: number;
  maxUsdPerEdition: number;
  /** (a) é `null` por construção — ver VIÉS DE SOBREVIVÊNCIA no topo. (c) cobre só custo: wall-clock não é avaliável retroativamente. */
  criteria: { a: boolean | null; b: boolean; c: boolean };
  reasons: string[];
}

/**
 * `strict: false` = regra pré-registrada como escrita ("manteve/aprovou" →
 * `publicado` ∪ `aprovado`); `strict: true` = só `publicado` (checagem de
 * robustez — o resto vira `sem_gabarito`).
 */
export function decide(evals: EditionEval[], opts: { strict?: boolean } = {}): Verdict {
  if (evals.length === 0) throw new Error("decide(): nenhuma edição avaliada — sem dados não há veredito");
  const strict = !!opts.strict;
  const n = evals.length;
  const tagged = evals.flatMap((e) =>
    e.dedup.map((d) => {
      const truth: Truth = strict && d.truth === "aprovado" ? "sem_gabarito" : d.truth;
      return { arm: e.arm, d: { ...d, truth, ...scoreAgainstTruth(truth, d.baselineDrops, d.jevDrops) } };
    }),
  );
  const all = tagged.map((t) => t.d);
  const statsOf = (ds: DedupDivergence[]): ArmStats => {
    const labeled = ds.filter((d) => d.truth !== "sem_gabarito");
    return {
      divergences: ds.length,
      labeled: labeled.length,
      jevHits: labeled.filter((d) => d.jevCorrect).length,
      baselineHits: labeled.filter((d) => d.baselineCorrect).length,
      jevGrave: ds.filter((d) => d.jevGrave).length,
    };
  };
  const total = statsOf(all);
  const byArm = {
    A: statsOf(tagged.filter((t) => t.arm === "A").map((t) => t.d)),
    B: statsOf(tagged.filter((t) => t.arm === "B").map((t) => t.d)),
    unknown: statsOf(tagged.filter((t) => t.arm === "unknown").map((t) => t.d)),
  };
  const grayPairs = evals.reduce((s, e) => s + e.grayPairs, 0);
  const verdicts = evals.reduce((s, e) => s + e.jevVerdicts, 0);
  const jevCoverage = grayPairs === 0 ? 1 : verdicts / grayPairs;
  const divergencesPerEdition = total.divergences / n;
  const maxUsdPerEdition = Math.max(0, ...evals.map((e) => e.estUsd));
  // (a) não é comparável somando braços (viés de sobrevivência, ver topo) —
  // nunca vira true, então a regra "se e somente se (a)∧(b)∧(c)" nunca chega
  // a "adotar" retroativamente: com (b)∧(c) ok o resultado é "inconclusivo".
  const a: boolean | null = null;
  const b = total.jevGrave === 0;
  const c = maxUsdPerEdition < RULE_MAX_USD_PER_EDITION;
  const reasons: string[] = [];
  let outcome: Verdict["outcome"];
  if (jevCoverage < MIN_JEV_COVERAGE) {
    outcome = "inconclusivo";
    reasons.push(`cobertura Jev ${(jevCoverage * 100).toFixed(0)}% < ${MIN_JEV_COVERAGE * 100}% — vereditos ausentes viram "sem divergência" (chave/API/cache?)`);
  } else if (divergencesPerEdition <= RULE_INDIFFERENT_MAX_DIVERGENCES_PER_EDITION) {
    outcome = "indiferente";
    reasons.push(`divergências raras: ${divergencesPerEdition.toFixed(2)}/edição (≤ ${RULE_INDIFFERENT_MAX_DIVERGENCES_PER_EDITION}) — decidir por custo/manutenção`);
  } else if (b && c) {
    outcome = a === true ? "adotar" : "inconclusivo";
    reasons.push(a === true ? "(a), (b) e (c) satisfeitos" : "(b) e (c) ok, mas (a) não demonstrável sem viés — precisa de gabarito cego dos dois lados");
  } else {
    outcome = "nao_adotar";
    if (!b) reasons.push(`(b) falhou: ${total.jevGrave} erro(s) grave(s) do Jev (descartou item que o editor ${strict ? "publicou" : "manteve/aprovou"})`);
    reasons.push("(a) não demonstrável sem viés (gabarito só existe para o que sobreviveu ao dedup ao vivo)");
    if (!c) reasons.push(`(c) falhou: até US$ ${maxUsdPerEdition.toFixed(4)}/edição`);
  }
  if (outcome === "indiferente" || outcome === "inconclusivo") {
    if (!b) reasons.push(`atenção: ${total.jevGrave} erro(s) grave(s) do Jev mesmo assim`);
    if (!c) reasons.push(`atenção: custo até US$ ${maxUsdPerEdition.toFixed(4)}/edição`);
  }
  return {
    outcome,
    strict,
    divergencesPerEdition,
    labeled: total.labeled,
    jevHits: total.jevHits,
    baselineHits: total.baselineHits,
    jevGrave: total.jevGrave,
    byArm,
    jevCoverage,
    maxUsdPerEdition,
    criteria: { a, b, c },
    reasons,
  };
}

export function renderPairedReport(
  evals: EditionEval[],
  verdict: Verdict,
  strictVerdict?: Verdict,
  skipped: Array<{ edition: string; reason: string }> = [],
): string {
  const L: string[] = [];
  L.push(`# Jev A/B — avaliação pareada retroativa (#9531)`);
  L.push("");
  L.push(`**Veredito pela regra pré-registrada: \`${verdict.outcome}\`** — ${verdict.reasons.join("; ")}`);
  L.push("");
  L.push(`- Edições: ${evals.length} (A=${evals.filter((e) => e.arm === "A").length}, B=${evals.filter((e) => e.arm === "B").length}, desconhecido=${evals.filter((e) => e.arm === "unknown").length})${skipped.length ? `; ${skipped.length} pulada(s) — ver Notas` : ""}`);
  L.push(`- Cobertura Jev na zona cinzenta: ${(verdict.jevCoverage * 100).toFixed(0)}% dos pares com veredito`);
  L.push(`- Decisões divergentes (dedup, nível artigo): ${evals.reduce((s, e) => s + e.dedup.length, 0)} — ${verdict.divergencesPerEdition.toFixed(2)}/edição`);
  L.push(`- Erros graves do Jev (descartou item que o editor manteve): ${verdict.jevGrave}`);
  L.push(`- Custo Jev estimado: máx US$ ${verdict.maxUsdPerEdition.toFixed(4)}/edição`);
  L.push(`- Critérios: (a) ${fmtBool(verdict.criteria.a)} · (b) ${fmtBool(verdict.criteria.b)} · (c, só custo) ${fmtBool(verdict.criteria.c)}`);
  if (strictVerdict) {
    L.push(`- **Robustez (gabarito só = publicado em 02-reviewed.md): \`${strictVerdict.outcome}\`** — ${strictVerdict.jevGrave} erro(s) grave(s)`);
  }
  L.push("");
  L.push(`### Por braço (o gabarito de cada braço só enxerga um lado da divergência)`);
  L.push("");
  L.push(`| braço | divergências | c/ gabarito | Jev certo | baseline certo | grave Jev | o que o gabarito mede |`);
  L.push(`|---|---|---|---|---|---|---|`);
  const meaning: Record<Arm, string> = {
    A: "falso descarte do Jev (b)",
    B: "acerto do Jev ao manter",
    unknown: "—",
  };
  for (const arm of ["A", "B", "unknown"] as Arm[]) {
    const s = verdict.byArm[arm];
    if (arm === "unknown" && s.divergences === 0) continue;
    L.push(`| ${arm} | ${s.divergences} | ${s.labeled} | ${s.jevHits} | ${s.baselineHits} | ${s.jevGrave} | ${meaning[arm]} |`);
  }
  L.push("");
  L.push(`### Limitações`);
  L.push("");
  L.push("- Viés de sobrevivência: gabarito só para o que passou pelo dedup ao vivo. (a) não é comparável somando braços; falsos descartes do Jev no braço B ficam invisíveis.");
  L.push("- \"Deixar passar repetição real\" (metade de b) não tem gabarito derivável — não medido.");
  L.push("- Pool reconstruído de `researcher-results.json` menos as URLs publicadas da janela (Pass 1); Pass 1b/1r e o dedup intra-lista não são modelados.");
  L.push("- Wall-clock do Stage 1 não é avaliável retroativamente; a coluna wall Jev soma o tempo das chamadas reais desta avaliação (concorrência 8).");
  L.push("");
  L.push(`| edição | braço | pool | pares zona | vereditos (ao vivo) | div. dedup | c/ gabarito | grave Jev | itens Brasil | div. Brasil | chamadas Jev | US$ est. | wall Jev |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const e of evals) {
    L.push(
      `| ${e.edition} | ${e.arm} | ${e.poolSize} | ${e.grayPairs}${e.grayPairsTruncated ? ` (+${e.grayPairsTruncated} acima do teto)` : ""} | ${e.jevVerdicts}${e.jevVerdictsRecorded ? ` (${e.jevVerdictsRecorded})` : ""} | ${e.dedup.length} | ${e.dedup.filter((d) => d.truth !== "sem_gabarito").length} | ${e.dedup.filter((d) => d.jevGrave).length} | ${e.brazilAnnotated}/${e.brazilItems} | ${e.brazil.length} | ${e.jevCalls} | ${e.estUsd.toFixed(4)} | ${e.jevWallMs === null ? "—" : `${(e.jevWallMs / 1000).toFixed(1)}s`} |`,
    );
  }
  L.push("");
  L.push(`## Divergências de dedup`);
  L.push("");
  const div = evals.flatMap((e) => e.dedup.map((d) => ({ e, d })));
  if (div.length === 0) L.push("_nenhuma_");
  for (const { e, d } of div) {
    const p = d.decisivePair;
    const v = p.verdict ? `p=${p.verdict.probability.toFixed(2)}, conf=${p.verdict.confidence.toFixed(2)}` : "sem veredito";
    L.push(
      `- ${e.edition} (${e.arm}) — **${d.jevDrops ? "Jev descarta / baseline mantém" : "Jev mantém / baseline descarta"}** — gabarito: \`${d.truth}\`${d.jevGrave ? " — ⚠️ ERRO GRAVE" : ""}\n  - "${d.title}" (${d.url})\n  - vs. "${p.past}" (Jaccard ${p.jaccard.toFixed(2)}, limiar ${p.threshold}, ${v})`,
    );
  }
  L.push("");
  L.push(`## Divergências de Brasil (só informativo — nenhuma decisão do pipeline diário consome \`brazil_p\`)`);
  L.push("");
  const bd = evals.flatMap((e) => e.brazil.map((d) => ({ e, d })));
  if (bd.length === 0) L.push("_nenhuma_");
  for (const { e, d } of bd) {
    L.push(`- ${e.edition} — regex=${d.baseline ? "BR" : "não"}, Jev=${d.jev ? "BR" : "não"} (p=${d.brazilP.toFixed(2)}) — "${d.title}"`);
  }
  const notes = [
    ...skipped.map((s) => `${s.edition}: PULADA — ${s.reason}`),
    ...evals.flatMap((e) => e.notes.map((n) => `${e.edition}: ${n}`)),
  ];
  if (notes.length > 0) {
    L.push("");
    L.push(`## Notas`);
    L.push("");
    for (const n of notes) L.push(`- ${n}`);
  }
  L.push("");
  return L.join("\n");
}

function fmtBool(v: boolean | null): string {
  return v === null ? "n/d" : v ? "✅" : "❌";
}
