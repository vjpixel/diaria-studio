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
 *     `confidence >= GRAYZONE_MIN_CONFIDENCE`, só na zona `[0.35, 0.85)`).
 *     A divergência é medida no nível do ARTIGO (o que de fato muda a
 *     edição): o artigo cai se QUALQUER par com título passado decidir
 *     "mesma história".
 *
 *  2. Brasil (`actor_brazil`): baseline = `detectBrazil()` (regex/host/
 *     categoria); Jev = `brazil_p >= JEV_BRAZIL_THRESHOLD`.
 *
 * Gabarito (nunca chutado): o editor só "vota" sobre o que chegou até ele.
 * Artigo divergente cuja URL está em `01-approved.json` ou `02-reviewed.md`
 * da edição → o editor MANTEVE → a resposta certa é "não é repetição"
 * (manter). Qualquer outro caso → `sem_gabarito`. Para Brasil não existe ato
 * do editor que revele a verdade → sempre `sem_gabarito`.
 *
 * Tudo aqui é puro (sem rede, sem fs) — I/O e chamadas Jev ficam no CLI
 * `scripts/jev-ab-paired-eval.ts`.
 */

import { jaccardSimilarity, thresholdForPair, tokenizeForJaccard } from "./title-similarity.ts";
import {
  GRAYZONE_MIN_CONFIDENCE,
  inGrayZone,
  pairKey,
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
/** Heurística de tokens por caractere pra estimar custo (a API não devolve usage pelo nosso cliente). */
export const CHARS_PER_TOKEN = 4;

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
  /** Veredito Jev do par (ausente fora da zona ou se a chamada falhou). */
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

export interface DedupDivergence {
  url: string;
  title: string;
  baselineDrops: boolean;
  jevDrops: boolean;
  /** Par que decidiu a queda do lado que derruba o artigo. */
  decisivePair: DedupPairEval;
  truth: Truth;
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
  arm: "A" | "B";
  poolSize: number;
  grayPairs: number;
  jevVerdicts: number;
  dedup: DedupDivergence[];
  brazilItems: number;
  brazilAnnotated: number;
  brazil: BrazilDivergence[];
  jevCalls: number;
  estTokens: number;
  estUsd: number;
  /** Wall-clock das chamadas Jev desta edição (ms) — `null` quando tudo veio do cache. */
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
  article?: { url?: string; title?: string; summary?: string };
}

export const APPROVED_BUCKETS = ["highlights", "runners_up", "lancamento", "radar", "use_melhor", "video"] as const;

/** Itens de um `01-approved.json`/`01-categorized.json` com o bucket de origem. */
export function approvedItems(doc: unknown): Array<{ url: string; title: string; summary: string; bucket: string }> {
  const out: Array<{ url: string; title: string; summary: string; bucket: string }> = [];
  if (!doc || typeof doc !== "object") return out;
  const seen = new Set<string>();
  for (const bucket of APPROVED_BUCKETS) {
    const arr = (doc as Record<string, unknown>)[bucket];
    if (!Array.isArray(arr)) continue;
    for (const it of arr as ApprovedLike[]) {
      const url = it?.article?.url ?? it?.url;
      const title = it?.article?.title ?? it?.title ?? "";
      if (!url) continue;
      const key = normalizeUrlForMatch(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url, title, summary: it?.article?.summary ?? it?.summary ?? "", bucket });
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
 * As `window` edições estritamente ANTERIORES a `current` (ordem decrescente) —
 * a janela que o dedup daquela edição viu (o `recentEditionDirs` de produção
 * pega "as mais recentes", que retroativamente incluiria edições futuras).
 */
export function pastWindow(all: string[], current: string, window: number): string[] {
  return [...new Set(all)].filter((d) => d < current).sort().reverse().slice(0, window);
}

/** `defaultWindowDays` do Stage 1, aplicado ao dia em que a pesquisa rodou (D-1 da edição). */
export function windowForEdition(aammdd: string): number {
  const y = 2000 + Number(aammdd.slice(0, 2));
  const m = Number(aammdd.slice(2, 4)) - 1;
  const d = Number(aammdd.slice(4, 6));
  const run = new Date(Date.UTC(y, m, d - 1));
  const day = run.getUTCDay();
  return day === 3 || day === 4 || day === 5 ? 3 : 4;
}

// ---------------------------------------------------------------------------
// Dedup zona cinzenta
// ---------------------------------------------------------------------------

/** Pares (artigo × título passado) da zona cinzenta — o que o perfil B consulta. */
export function grayZonePairs(pool: PoolArticle[], pastTitles: string[]): Array<{ article: PoolArticle; past: string; jaccard: number }> {
  const pastTok = pastTitles.map((t) => ({ t, tok: tokenizeForJaccard(t) }));
  const out: Array<{ article: PoolArticle; past: string; jaccard: number }> = [];
  const seen = new Set<string>();
  for (const a of pool) {
    const tok = tokenizeForJaccard(a.title);
    if (tok.size === 0) continue;
    for (const p of pastTok) {
      const sim = jaccardSimilarity(tok, p.tok);
      if (!inGrayZone(sim)) continue;
      const k = pairKey(a.title, p.t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ article: a, past: p.t, jaccard: sim });
    }
  }
  return out;
}

/**
 * Decisão por artigo nas duas lógicas. Pares fora da zona decidem igual nos
 * dois lados (é o que `createGrayZoneResolver` faz em produção); na zona, o
 * Jev decide quando há veredito com confiança suficiente.
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

export function labelDedupDivergence(
  article: PoolArticle,
  ev: { baselineDrops: boolean; jevDrops: boolean; pairs: DedupPairEval[] },
  editorKept: { published: Set<string>; approved: Set<string> },
): DedupDivergence | null {
  if (ev.baselineDrops === ev.jevDrops) return null;
  const decisive = [...ev.pairs]
    .filter((p) => (ev.jevDrops ? p.jevSame && !p.heuristicSame : p.heuristicSame && !p.jevSame))
    .sort((a, b) => b.jaccard - a.jaccard)[0] ?? ev.pairs[0];
  const key = normalizeUrlForMatch(article.url);
  const truth: Truth = editorKept.published.has(key) ? "publicado" : editorKept.approved.has(key) ? "aprovado" : "sem_gabarito";
  const kept = truth !== "sem_gabarito";
  return {
    url: article.url,
    title: article.title,
    baselineDrops: ev.baselineDrops,
    jevDrops: ev.jevDrops,
    decisivePair: decisive,
    truth,
    baselineCorrect: kept ? !ev.baselineDrops : null,
    jevCorrect: kept ? !ev.jevDrops : null,
    jevGrave: kept && ev.jevDrops,
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

export interface Verdict {
  outcome: "adotar" | "nao_adotar" | "indiferente";
  divergencesPerEdition: number;
  labeled: number;
  jevHits: number;
  baselineHits: number;
  jevGrave: number;
  maxUsdPerEdition: number;
  criteria: { a: boolean | null; b: boolean; c: boolean };
  reasons: string[];
}

/**
 * `strict: false` = regra pré-registrada como escrita ("manteve/aprovou" →
 * `publicado` ∪ `aprovado`); `strict: true` = só `publicado` (checagem de
 * robustez — o resto vira `sem_gabarito`).
 */
export function decide(evals: EditionEval[], opts: { strict?: boolean } = {}): Verdict {
  const n = evals.length;
  const allDiv = evals.flatMap((e) => e.dedup).map((d) =>
    opts.strict && d.truth === "aprovado"
      ? { ...d, truth: "sem_gabarito" as const, baselineCorrect: null, jevCorrect: null, jevGrave: false }
      : d,
  );
  const decisionDivergences = allDiv.length; // Brasil não muda decisão no pipeline diário
  const divergencesPerEdition = n === 0 ? 0 : decisionDivergences / n;
  const labeled = allDiv.filter((d) => d.truth !== "sem_gabarito");
  const jevHits = labeled.filter((d) => d.jevCorrect).length;
  const baselineHits = labeled.filter((d) => d.baselineCorrect).length;
  const jevGrave = allDiv.filter((d) => d.jevGrave).length;
  const maxUsdPerEdition = Math.max(0, ...evals.map((e) => e.estUsd));
  const a = labeled.length === 0 ? null : jevHits > baselineHits;
  const b = jevGrave === 0;
  const c = maxUsdPerEdition < RULE_MAX_USD_PER_EDITION;
  const reasons: string[] = [];
  let outcome: Verdict["outcome"];
  if (divergencesPerEdition <= RULE_INDIFFERENT_MAX_DIVERGENCES_PER_EDITION) {
    outcome = "indiferente";
    reasons.push(`divergências raras: ${divergencesPerEdition.toFixed(2)}/edição (≤ ${RULE_INDIFFERENT_MAX_DIVERGENCES_PER_EDITION}) — decidir por custo/manutenção`);
  } else if (a === true && b && c) {
    outcome = "adotar";
    reasons.push("(a), (b) e (c) satisfeitos");
  } else {
    outcome = "nao_adotar";
    if (a !== true) reasons.push(a === null ? "(a) sem divergência com gabarito — não demonstrável" : `(a) falhou: Jev ${jevHits} × baseline ${baselineHits}`);
    if (!b) reasons.push(`(b) falhou: ${jevGrave} erro(s) grave(s) do Jev`);
    if (!c) reasons.push(`(c) falhou: até US$ ${maxUsdPerEdition.toFixed(4)}/edição`);
  }
  return { outcome, divergencesPerEdition, labeled: labeled.length, jevHits, baselineHits, jevGrave, maxUsdPerEdition, criteria: { a, b, c }, reasons };
}

export function renderPairedReport(evals: EditionEval[], verdict: Verdict, strictVerdict?: Verdict): string {
  const L: string[] = [];
  L.push(`# Jev A/B — avaliação pareada retroativa (#9531)`);
  L.push("");
  L.push(`**Veredito pela regra pré-registrada: \`${verdict.outcome}\`** — ${verdict.reasons.join("; ")}`);
  L.push("");
  L.push(`- Edições: ${evals.length} (A=${evals.filter((e) => e.arm === "A").length}, B=${evals.filter((e) => e.arm === "B").length})`);
  L.push(`- Decisões divergentes (dedup, nível artigo): ${evals.reduce((s, e) => s + e.dedup.length, 0)} — ${verdict.divergencesPerEdition.toFixed(2)}/edição`);
  L.push(`- Com gabarito: ${verdict.labeled} — acerto Jev ${verdict.jevHits}/${verdict.labeled}, baseline ${verdict.baselineHits}/${verdict.labeled}`);
  L.push(`- Erros graves do Jev (descartou item que o editor manteve): ${verdict.jevGrave}`);
  L.push(`- Custo Jev estimado: máx US$ ${verdict.maxUsdPerEdition.toFixed(4)}/edição`);
  L.push(`- Critérios: (a) ${fmtBool(verdict.criteria.a)} · (b) ${fmtBool(verdict.criteria.b)} · (c) ${fmtBool(verdict.criteria.c)}`);
  if (strictVerdict) {
    L.push(`- **Robustez (gabarito só = publicado em 02-reviewed.md): \`${strictVerdict.outcome}\`** — Jev ${strictVerdict.jevHits}/${strictVerdict.labeled}, baseline ${strictVerdict.baselineHits}/${strictVerdict.labeled}, ${strictVerdict.jevGrave} erro(s) grave(s)`);
  }
  L.push("- Wall Jev = soma do tempo das chamadas da edição (concorrência 8); em produção o dedup só consulta a zona cinzenta, o que é uma fração disso.");
  L.push("");
  L.push(`| edição | braço | pool | pares zona | vereditos | div. dedup | c/ gabarito | grave Jev | itens Brasil | div. Brasil | chamadas Jev | US$ est. | wall Jev |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const e of evals) {
    L.push(
      `| ${e.edition} | ${e.arm} | ${e.poolSize} | ${e.grayPairs} | ${e.jevVerdicts} | ${e.dedup.length} | ${e.dedup.filter((d) => d.truth !== "sem_gabarito").length} | ${e.dedup.filter((d) => d.jevGrave).length} | ${e.brazilAnnotated}/${e.brazilItems} | ${e.brazil.length} | ${e.jevCalls} | ${e.estUsd.toFixed(4)} | ${e.jevWallMs === null ? "cache" : `${(e.jevWallMs / 1000).toFixed(1)}s`} |`,
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
      `- ${e.edition} — **${d.jevDrops ? "Jev descarta / baseline mantém" : "Jev mantém / baseline descarta"}** — gabarito: \`${d.truth}\`${d.jevGrave ? " — ⚠️ ERRO GRAVE" : ""}\n  - "${d.title}" (${d.url})\n  - vs. "${p.past}" (Jaccard ${p.jaccard.toFixed(2)}, limiar ${p.threshold}, ${v})`,
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
  const notes = evals.flatMap((e) => e.notes.map((n) => `${e.edition}: ${n}`));
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
