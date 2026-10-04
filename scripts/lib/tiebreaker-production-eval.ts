/**
 * tiebreaker-production-eval.ts (#8419 — Medição 6 do epic #8412)
 *
 * Miolo puro da medição de PRODUÇÃO do tie-breaker semântico do #8211
 * (`scripts/lib/semantic-tiebreaker.ts`). Nada aqui muda produção — só lê o
 * que a pipeline já gravou e compara.
 *
 * Gabarito: a seção em que o item SAIU publicado em `02-reviewed.md` (estado
 * final aprovado pelo editor no gate do Stage 4). É a decisão do editor sobre
 * o bucket — inclui as correções do gate do Stage 1 e as do Stage 4. Itens que
 * viraram DESTAQUE ou foram cortados não entram no gabarito (a seção do
 * destaque não diz o bucket; corte não diz nada sobre bucket).
 *
 * Três classificadores sobre o MESMO conjunto de itens:
 *  - `tiebreaker`: o bucket que o #8211 gravou (`category_rule:
 *    semantic-tiebreaker-*`, lido de `_internal/01-categorized.json`);
 *  - `baseline`: o default silencioso que o determinístico teria aplicado sem
 *    o tie-breaker (`lancamento-default`/`noticias-default`) — recomputado com
 *    `categorizeWithRule`, porque o tie-breaker sobrescreve `category_rule`;
 *  - `extended` (opcional, item 2 da issue): a resposta da Choice estendida
 *    (`TIEBREAKER_EXTENDED_8419`), mapeada pra bucket com a mesma composição
 *    #160 do tie-breaker de produção.
 */

import { canonicalize } from "./url-utils.ts";
import { parseSections } from "./newsletter-parse.ts";
import { categorizeWithRule, isFallbackCategorizationRule, isOfficialLancamentoUrl, type Bucket } from "./launch-heuristics.ts";
import { mcnemarTest, type McNemarResult } from "./mcnemar.ts";
import type { Article } from "./types/article.ts";

/** Onde o item saiu na edição publicada. `destaque` não é gabaritável (ver docblock). */
export type PublishedPlacement = Bucket | "destaque";

/** Acurácia offline do #8211 (gabarito cego n=22, 17/09/2026) — o critério do item 3 da issue. */
export const OFFLINE_CORRECT = 20;
export const OFFLINE_N = 22;
/** Faixa da reprodução do #8413 (3 rodadas, API não determinística — docs/jev.md). */
export const OFFLINE_REPRO_RANGE: readonly [number, number] = [17 / 22, 19 / 22];

const TIEBREAKER_RULE_PREFIX = "semantic-tiebreaker-";

export function isTiebreakerRule(rule: string | undefined | null): boolean {
  return typeof rule === "string" && rule.startsWith(TIEBREAKER_RULE_PREFIX);
}

/**
 * Nome de seção (já normalizado por `parseSections` — plural, sem emoji) →
 * bucket. Seções legadas (`NOTÍCIAS`, `PESQUISAS`, `OUTRAS NOTÍCIAS`) caem em
 * `radar` (fundidas em #1569). Nome desconhecido → null (não gabarita).
 */
export function sectionNameToBucket(name: string): Bucket | null {
  const n = name.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (n.startsWith("LANCAMENTO")) return "lancamento";
  if (n === "USE MELHOR") return "use_melhor";
  if (n.startsWith("VIDEO")) return "video";
  if (n === "RADAR" || n.includes("NOTICIA") || n.startsWith("PESQUISA")) return "radar";
  return null;
}

const DESTAQUE_HEADER_RE = /DESTAQUE\s+\d/;
const MD_LINK_URL_RE = /\]\((https?:\/\/[^)\s]+)\)/;

/**
 * URL canônica → onde saiu publicada, a partir do markdown de
 * `02-reviewed.md`. Destaques são detectados pelo header `DESTAQUE N` do
 * bloco (o 1º link do bloco é o do destaque). Se a mesma URL aparecer em mais
 * de um lugar, a 1ª ocorrência vence (destaques vêm antes das seções).
 */
export function parsePublishedPlacements(md: string): Map<string, PublishedPlacement> {
  const out = new Map<string, PublishedPlacement>();
  for (const block of md.split(/^---$/m)) {
    if (!DESTAQUE_HEADER_RE.test(block)) continue;
    const m = MD_LINK_URL_RE.exec(block);
    if (m) {
      const key = canonicalize(m[1]);
      if (!out.has(key)) out.set(key, "destaque");
    }
  }
  for (const section of parseSections(md)) {
    const bucket = sectionNameToBucket(section.name);
    if (!bucket) continue;
    for (const item of section.items) {
      if (!item.url) continue;
      const key = canonicalize(item.url);
      if (!out.has(key)) out.set(key, bucket);
    }
  }
  return out;
}

/** Artigo como gravado em `_internal/01-categorized.json`. */
export type CategorizedArticle = Article & { title_raw?: string; category_rule?: string };

export interface CategorizedFile {
  lancamento?: CategorizedArticle[];
  radar?: CategorizedArticle[];
  use_melhor?: CategorizedArticle[];
  video?: CategorizedArticle[];
}

export interface TiebreakerDecision {
  edition: string;
  url: string;
  title: string;
  summary: string;
  rule: string;
  /** Bucket decidido pelo tie-breaker de produção (derivado da regra). */
  tiebreaker: Bucket;
  /** Bucket em que o item está em `01-categorized.json` (pode divergir — ver `tiebreakerVerdictFromRule`). */
  storedBucket: Bucket;
  /** Bucket do default silencioso que o determinístico teria usado. */
  baseline: Bucket;
  /**
   * true quando o código ATUAL do categorizador já não cai num default pra
   * este artigo (regra forte nova desde a edição). Nesse caso o baseline vira
   * a aproximação do default (`isOfficialLancamentoUrl` → lancamento, senão
   * radar), porque é o default — não a regra nova — que o tie-breaker
   * substituiu na hora.
   */
  baselineDrift: boolean;
}

/**
 * Recompõe o bucket que o determinístico daria SEM o tie-breaker. Usa o título
 * cru da fonte (`title_raw`, #9380) quando existir, porque é ele que as
 * heurísticas de título viram na hora.
 */
export function baselineBucketFor(a: CategorizedArticle): { bucket: Bucket; drift: boolean } {
  const { category, rule } = categorizeWithRule({ ...a, title: a.title_raw ?? a.title } as Article);
  if (isFallbackCategorizationRule(rule)) {
    return { bucket: category === "lancamento" ? "lancamento" : "radar", drift: false };
  }
  return { bucket: isOfficialLancamentoUrl(a.url) ? "lancamento" : "radar", drift: true };
}

/**
 * Veredito do tie-breaker lido da REGRA, não do bucket em que o item está no
 * arquivo: passos posteriores do Stage 1 podem mover o item de bucket sem
 * reescrever `category_rule` (visto no corpus real: `semantic-tiebreaker-
 * lancamento` dentro de `radar`). A regra é o que o tie-breaker decidiu.
 */
export function tiebreakerVerdictFromRule(rule: string): Bucket {
  return rule === "semantic-tiebreaker-lancamento" ? "lancamento" : "radar";
}

export function collectTiebreakerDecisions(edition: string, cat: CategorizedFile): TiebreakerDecision[] {
  const out: TiebreakerDecision[] = [];
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const a of cat[bucket] ?? []) {
      if (!isTiebreakerRule(a.category_rule)) continue;
      const base = baselineBucketFor(a);
      out.push({
        edition,
        url: a.url,
        title: a.title ?? "",
        summary: a.summary ?? "",
        rule: a.category_rule!,
        tiebreaker: tiebreakerVerdictFromRule(a.category_rule!),
        storedBucket: bucket,
        baseline: base.bucket,
        baselineDrift: base.drift,
      });
    }
  }
  return out;
}

export interface GradedDecision extends TiebreakerDecision {
  /** Onde saiu publicada; null = não publicada (cortada). */
  placement: PublishedPlacement | null;
}

export function gradeDecisions(decisions: TiebreakerDecision[], placements: Map<string, PublishedPlacement>): GradedDecision[] {
  return decisions.map((d) => ({ ...d, placement: placements.get(canonicalize(d.url)) ?? null }));
}

/** Itens gabaritáveis: publicados numa seção de bucket (não destaque, não cortados). */
export function gradable(g: GradedDecision[]): Array<GradedDecision & { placement: Bucket }> {
  return g.filter((x): x is GradedDecision & { placement: Bucket } => x.placement !== null && x.placement !== "destaque");
}

/** Intervalo de Wilson 95% pra proporção. */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface PairedComparison {
  n: number;
  aCorrect: number;
  bCorrect: number;
  mcnemar: McNemarResult;
}

export function pairedCompare<T>(items: T[], aOk: (x: T) => boolean, bOk: (x: T) => boolean): PairedComparison {
  let aCorrect = 0;
  let bCorrect = 0;
  let aOnly = 0;
  let bOnly = 0;
  for (const x of items) {
    const a = aOk(x);
    const b = bOk(x);
    if (a) aCorrect++;
    if (b) bCorrect++;
    if (a && !b) aOnly++;
    if (!a && b) bOnly++;
  }
  return { n: items.length, aCorrect, bCorrect, mcnemar: mcnemarTest({ aCorrectBWrong: aOnly, aWrongBCorrect: bOnly }) };
}

export interface ProductionSummary {
  editions: string[];
  decisions: number;
  byRule: Record<string, number>;
  placements: Record<string, number>;
  gradable: number;
  baselineDrift: number;
  /** Decisões em que o tie-breaker MUDOU o default silencioso, e onde elas foram parar. */
  changedVsDefault: number;
  changedPlacements: Record<string, number>;
  /** Itens cujo bucket no arquivo diverge do veredito da regra (movidos depois por outro passo). */
  storedMismatch: number;
  /** tie-breaker × baseline, gabarito = seção publicada (3 vias: lancamento/radar/use_melhor/video). */
  tiebreakerVsBaseline: PairedComparison;
  tiebreakerCI: [number, number];
  /** Restrito a itens cujo gabarito cabe na Choice de produção ({lancamento, radar}). */
  inChoice: PairedComparison;
  inChoiceCI: [number, number];
  /** Confusão tie-breaker (linha) × publicado (coluna). */
  confusion: Record<string, Record<string, number>>;
  /** Itens que o tie-breaker não tinha como acertar (gabarito fora da Choice). */
  outOfChoice: Array<GradedDecision & { placement: Bucket }>;
  /** Erros do tie-breaker dentro da Choice. */
  inChoiceErrors: Array<GradedDecision & { placement: Bucket }>;
  /** Item 3: produção pior que o gabarito offline? (Wilson 95% superior < 20/22.) */
  worseThanOffline: boolean;
}

export function summarizeProduction(graded: GradedDecision[]): ProductionSummary {
  const g = gradable(graded);
  const byRule: Record<string, number> = {};
  const placements: Record<string, number> = {};
  const confusion: Record<string, Record<string, number>> = {};
  for (const d of graded) {
    byRule[d.rule] = (byRule[d.rule] ?? 0) + 1;
    const p = d.placement ?? "cortado";
    placements[p] = (placements[p] ?? 0) + 1;
  }
  for (const d of g) {
    confusion[d.tiebreaker] ??= {};
    confusion[d.tiebreaker][d.placement] = (confusion[d.tiebreaker][d.placement] ?? 0) + 1;
  }
  const changed = graded.filter((d) => d.tiebreaker !== d.baseline);
  const changedPlacements: Record<string, number> = {};
  for (const d of changed) {
    const p = d.placement ?? "cortado";
    changedPlacements[p] = (changedPlacements[p] ?? 0) + 1;
  }
  const tvb = pairedCompare(g, (x) => x.tiebreaker === x.placement, (x) => x.baseline === x.placement);
  const inChoiceItems = g.filter((x) => x.placement === "lancamento" || x.placement === "radar");
  const inChoice = pairedCompare(inChoiceItems, (x) => x.tiebreaker === x.placement, (x) => x.baseline === x.placement);
  const tiebreakerCI = wilsonInterval(tvb.aCorrect, tvb.n);
  const inChoiceCI = wilsonInterval(inChoice.aCorrect, inChoice.n);
  return {
    editions: [...new Set(graded.map((d) => d.edition))].sort(),
    decisions: graded.length,
    byRule,
    placements,
    gradable: g.length,
    baselineDrift: graded.filter((d) => d.baselineDrift).length,
    changedVsDefault: changed.length,
    changedPlacements,
    storedMismatch: graded.filter((d) => d.storedBucket !== d.tiebreaker).length,
    tiebreakerVsBaseline: tvb,
    tiebreakerCI,
    inChoice,
    inChoiceCI,
    confusion,
    outOfChoice: g.filter((x) => x.placement !== "lancamento" && x.placement !== "radar"),
    inChoiceErrors: inChoiceItems.filter((x) => x.tiebreaker !== x.placement),
    worseThanOffline: isWorseThanOffline(tvb.aCorrect, tvb.n),
  };
}

/**
 * Critério do item 3 ("se a medição de produção for pior que o gabarito
 * offline, parar"): pior = o limite SUPERIOR do Wilson 95% da produção fica
 * abaixo do ponto offline (20/22). Ponto abaixo mas dentro do intervalo é
 * empate estatístico, não "pior" — n=22 offline não sustenta mais que isso.
 */
export function isWorseThanOffline(correct: number, n: number): boolean {
  if (n === 0) return false;
  return wilsonInterval(correct, n)[1] < OFFLINE_CORRECT / OFFLINE_N;
}

// ---------------------------------------------------------------------------
// Acerto por regra (todas as regras, não só o tie-breaker) — insumo do item 2
// ("lista [de regras fracas] a definir a partir da medição")
// ---------------------------------------------------------------------------

export interface RuleTally {
  correct: number;
  total: number;
  /** destino publicado dos erros, pra ver pra onde a regra erra. */
  missTo: Record<string, number>;
}

/** Acumula, por `category_rule`, quantos itens publicados numa seção saíram no bucket que a regra deu. */
export function tallyRuleAccuracy(
  cat: CategorizedFile,
  placements: Map<string, PublishedPlacement>,
  into: Record<string, RuleTally> = {},
): Record<string, RuleTally> {
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const a of cat[bucket] ?? []) {
      if (!a.category_rule || !a.url) continue;
      const p = placements.get(canonicalize(a.url));
      if (!p || p === "destaque") continue;
      const t = (into[a.category_rule] ??= { correct: 0, total: 0, missTo: {} });
      const expected = isTiebreakerRule(a.category_rule) ? tiebreakerVerdictFromRule(a.category_rule) : bucket;
      t.total++;
      if (p === expected) t.correct++;
      else t.missTo[p] = (t.missTo[p] ?? 0) + 1;
    }
  }
  return into;
}

export function renderRuleTable(tally: Record<string, RuleTally>, minErrors = 1): string {
  const rows = Object.entries(tally)
    .filter(([, t]) => t.total - t.correct >= minErrors)
    .sort(([, a], [, b]) => b.total - b.correct - (a.total - a.correct));
  const L = [`### Regras com erro contra o publicado (todas as regras)`, "", `| regra | acerto | erros → destino |`, `|---|---|---|`];
  for (const [rule, t] of rows) {
    L.push(`| \`${rule}\` | ${t.correct}/${t.total} | ${Object.entries(t.missTo).map(([k, n]) => `${k} ${n}`).join(", ")} |`);
  }
  if (rows.length === 0) L.push(`| (nenhuma) | | |`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Item 2 — Choice estendida
// ---------------------------------------------------------------------------

/**
 * Resposta da Choice estendida → bucket, com a mesma composição #160 do
 * tie-breaker de produção (`lancamento` só com domínio oficial, senão
 * `radar`). `pesquisa` → `radar` (fundidas no #1569). Choice desconhecida → null.
 */
export function extendedChoiceToBucket(choice: string, url: string): Bucket | null {
  switch (choice) {
    case "lancamento":
      return isOfficialLancamentoUrl(url) ? "lancamento" : "radar";
    case "radar":
    case "pesquisa":
      return "radar";
    case "use_melhor":
      return "use_melhor";
    case "video":
      return "video";
    default:
      return null;
  }
}

export interface ExtendedRun {
  /** url → bucket da Choice estendida (só itens com resposta). */
  answers: Map<string, Bucket>;
  errors: number;
}

export interface ExtendedComparison extends PairedComparison {
  run: number;
  answered: number;
  errors: number;
  /** Itens em que estendida e produção discordam (bucket de cada um + publicado). */
  discordant: Array<{ url: string; title: string; placement: Bucket; production: Bucket; extended: Bucket }>;
}

/** Extended (A) × tie-breaker de produção (B) sobre os itens gabaritáveis respondidos. */
export function compareExtended(
  items: Array<GradedDecision & { placement: Bucket }>,
  run: ExtendedRun,
  runIndex: number,
): ExtendedComparison {
  const answered = items.filter((x) => run.answers.has(canonicalize(x.url)));
  const cmp = pairedCompare(
    answered,
    (x) => run.answers.get(canonicalize(x.url)) === x.placement,
    (x) => x.tiebreaker === x.placement,
  );
  const discordant = answered
    .map((x) => ({ url: x.url, title: x.title, placement: x.placement, production: x.tiebreaker, extended: run.answers.get(canonicalize(x.url))! }))
    .filter((d) => d.extended !== d.production);
  return { ...cmp, run: runIndex, answered: answered.length, errors: run.errors, discordant };
}

/**
 * Veredito do item 2: adotar só se TODAS as rodadas mostram a estendida à
 * frente E pelo menos uma com McNemar exato p<0,05 — a API não é
 * determinística (docs/jev.md), então decide-se pela faixa, não pelo ponto.
 */
export function extendedVerdict(runs: ExtendedComparison[]): "adotar" | "nao-adotar" | "sem-dado" {
  if (runs.length === 0 || runs.every((r) => r.answered === 0)) return "sem-dado";
  const allAhead = runs.every((r) => r.aCorrect > r.bCorrect);
  const anySignificant = runs.some((r) => r.mcnemar.pValueExact < 0.05);
  return allAhead && anySignificant ? "adotar" : "nao-adotar";
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const pct = (k: number, n: number) => (n === 0 ? "—" : `${((100 * k) / n).toFixed(1)}%`);
const pctRange = ([lo, hi]: [number, number]) => `${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}%`;
const fmtP = (p: number) => (p < 0.001 ? "<0,001" : p.toFixed(3).replace(".", ","));

export function renderProductionReport(s: ProductionSummary): string {
  const L: string[] = [];
  const t = s.tiebreakerVsBaseline;
  L.push(`### Acurácia de produção do tie-breaker #8211`);
  L.push("");
  L.push(`Edições: ${s.editions.length} (${s.editions[0] ?? "—"}–${s.editions[s.editions.length - 1] ?? "—"}) · decisões do tie-breaker: ${s.decisions}`);
  L.push(`Regras: ${Object.entries(s.byRule).map(([r, n]) => `\`${r}\` ${n}`).join(" · ")}`);
  L.push(`Destino publicado: ${Object.entries(s.placements).map(([p, n]) => `${p} ${n}`).join(" · ")}`);
  L.push(`Gabaritáveis (publicados numa seção, fora destaque): **${s.gradable}**${s.baselineDrift ? ` · baseline aproximado por drift de regra: ${s.baselineDrift}` : ""}`);
  L.push(`Decisões em que o tie-breaker mudou o default: ${s.changedVsDefault} → ${Object.entries(s.changedPlacements).map(([p, n]) => `${p} ${n}`).join(" · ") || "—"}${s.storedMismatch ? ` · itens movidos de bucket depois do tie-breaker (veredito lido da regra): ${s.storedMismatch}` : ""}`);
  L.push("");
  L.push(`| | acerto | IC Wilson 95% |`);
  L.push(`|---|---|---|`);
  L.push(`| Tie-breaker (produção) | ${t.aCorrect}/${t.n} (${pct(t.aCorrect, t.n)}) | ${pctRange(s.tiebreakerCI)} |`);
  L.push(`| Default silencioso (sem tie-breaker) | ${t.bCorrect}/${t.n} (${pct(t.bCorrect, t.n)}) | ${pctRange(wilsonInterval(t.bCorrect, t.n))} |`);
  L.push(`| Gabarito offline #8211 | ${OFFLINE_CORRECT}/${OFFLINE_N} (${pct(OFFLINE_CORRECT, OFFLINE_N)}) | reprodução #8413: ${pctRange([OFFLINE_REPRO_RANGE[0], OFFLINE_REPRO_RANGE[1]])} |`);
  L.push("");
  L.push(`McNemar tie-breaker × default: só tie-breaker acerta ${t.mcnemar.b}, só default acerta ${t.mcnemar.c} — p exato ${fmtP(t.mcnemar.pValueExact)}.`);
  L.push(`Dentro da Choice de produção ({lancamento, radar}): tie-breaker ${s.inChoice.aCorrect}/${s.inChoice.n} (${pct(s.inChoice.aCorrect, s.inChoice.n)}, IC ${pctRange(s.inChoiceCI)}) · default ${s.inChoice.bCorrect}/${s.inChoice.n}.`);
  L.push("");
  L.push(`Confusão (linha = tie-breaker, coluna = publicado):`);
  const cols = ["lancamento", "radar", "use_melhor", "video"];
  L.push(`| | ${cols.join(" | ")} |`);
  L.push(`|---|${cols.map(() => "---").join("|")}|`);
  for (const row of ["lancamento", "radar"]) {
    L.push(`| ${row} | ${cols.map((c) => s.confusion[row]?.[c] ?? 0).join(" | ")} |`);
  }
  L.push("");
  if (s.inChoiceErrors.length) {
    L.push(`Erros dentro da Choice (${s.inChoiceErrors.length}):`);
    for (const e of s.inChoiceErrors) L.push(`- ${e.edition} \`${e.rule}\` → publicado ${e.placement}: ${e.title} — ${e.url}`);
    L.push("");
  }
  if (s.outOfChoice.length) {
    L.push(`Fora da Choice — o tie-breaker não tinha como acertar (${s.outOfChoice.length}):`);
    for (const e of s.outOfChoice) L.push(`- ${e.edition} \`${e.rule}\` → publicado ${e.placement}: ${e.title} — ${e.url}`);
    L.push("");
  }
  L.push(
    s.worseThanOffline
      ? `**Item 3: produção PIOR que o gabarito offline** (IC superior ${pctRange(s.tiebreakerCI)} < ${pct(OFFLINE_CORRECT, OFFLINE_N)}) — parar, não estender.`
      : `**Item 3: produção não é pior que o gabarito offline** (o ponto offline ${pct(OFFLINE_CORRECT, OFFLINE_N)} está dentro ou abaixo do IC de produção) — segue para o item 2.`,
  );
  return L.join("\n");
}

export function renderExtendedReport(runs: ExtendedComparison[]): string {
  const L: string[] = [];
  L.push(`### Item 2 — Choice estendida {lancamento, radar, use_melhor, pesquisa, video}`);
  L.push("");
  L.push(`Mesmos itens gabaritáveis, só os que caíram nos defaults silenciosos (regra fraca). \`pesquisa\` → radar; \`lancamento\` sem domínio oficial → radar (#160).`);
  L.push("");
  L.push(`| rodada | respondidos | estendida | produção | só estendida acerta | só produção acerta | McNemar p exato |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const r of runs) {
    L.push(`| ${r.run} | ${r.answered}${r.errors ? ` (+${r.errors} erro)` : ""} | ${r.aCorrect}/${r.n} (${pct(r.aCorrect, r.n)}) | ${r.bCorrect}/${r.n} (${pct(r.bCorrect, r.n)}) | ${r.mcnemar.b} | ${r.mcnemar.c} | ${fmtP(r.mcnemar.pValueExact)} |`);
  }
  L.push("");
  const seen = new Map<string, { d: ExtendedComparison["discordant"][number]; runs: number[] }>();
  for (const r of runs) for (const d of r.discordant) {
    const k = `${d.url}|${d.extended}`;
    const e = seen.get(k) ?? { d, runs: [] };
    e.runs.push(r.run);
    seen.set(k, e);
  }
  if (seen.size) {
    L.push(`Discordâncias estendida × produção:`);
    for (const { d, runs: rs } of seen.values()) {
      L.push(`- estendida=${d.extended}, produção=${d.production}, publicado=${d.placement} (rodadas ${rs.join(",")}): ${d.title} — ${d.url}`);
    }
    L.push("");
  }
  const v = extendedVerdict(runs);
  L.push(
    v === "adotar"
      ? `**Veredito item 2: ADOTAR a extensão** (estendida à frente em todas as rodadas, com significância).`
      : v === "nao-adotar"
        ? `**Veredito item 2: NÃO ADOTAR a extensão** (sem ganho consistente e significativo sobre a produção).`
        : `**Item 2: sem dado** (nenhuma resposta da API).`,
  );
  return L.join("\n");
}
