/**
 * categorizer-replay.ts (#9882) — eval de replay do categorizador.
 *
 * O categorizador da diária é TS determinístico (`categorizeWithRule()` em
 * `scripts/lib/launch-heuristics.ts`), não um agent LLM — então o eval de
 * replay do #8144 (que re-roda o prompt de um agent contra edições passadas)
 * não se aplica a ele. O equivalente aqui é mais barato e exato: reaplicar o
 * código ATUAL sobre o input congelado de cada edição
 * (`_internal/01-categorized.json`) e comparar com o bucket em que o editor
 * deixou o item (`_internal/01-approved.json`). Custa zero chamada de API.
 *
 * Por que versionar: as duas rodadas anteriores de ajuste do categorizador
 * (#7331 e PR #9649, ambas na #5995) refizeram essa maquinaria num script de
 * scratchpad que foi apagado depois. Cada ajuste novo de rubrica de bucket
 * (inclusive os pedidos `bucket-move` do loop de aprendizado, #9882) precisa
 * da mesma régua de antes/depois — melhorias × regressões no corpus inteiro,
 * nunca "parece melhor".
 *
 * Gabarito = bucket no `01-approved.json`. Inclui os itens recategorizados no
 * Stage 4 (`stage4_recategorized_note`): para a pergunta "o código acerta a
 * seção que o editor quer?", a decisão final do editor é gabarito igualmente
 * válido — diferente de `diffBucketOverrides`, que mede o ATRITO do gate do
 * Stage 1 e por isso os exclui.
 *
 * Duas limitações declaradas:
 *  1. O tie-breaker semântico (#8211) chama a API da TypeSafe e não roda
 *     offline. Quando o item congelado foi decidido por ele E o código atual
 *     ainda cai num default silencioso, o replay reaproveita o veredito
 *     gravado no `category_rule` congelado e recompõe só o gate de domínio
 *     oficial (`composeWithOfficialDomainGate`), que é determinístico — assim
 *     uma mudança na allowlist oficial (ex: #9848) aparece no replay.
 *  2. O gate de relevância-IA de `categorizeArticles()` (drop) não é
 *     reaplicado — o replay só mede bucket de item que sobreviveu.
 *
 * Silêncio do editor (item deixado onde o categorizador pôs) entra como
 * gabarito, com o mesmo caveat do comentário de 17/09 na #5995: é sinal
 * mais fraco que um movimento explícito. Por isso o relatório separa
 * "movimentos do editor ainda errados" (resíduo) de "acordo geral".
 */

import type { Article } from "./types/article.ts";
import {
  categorizeWithRule,
  categoryToBucket,
  isFallbackCategorizationRule,
  type Bucket,
  type CategorizationResult,
} from "./launch-heuristics.ts";
import { composeWithOfficialDomainGate, type TieBreakerVerdict } from "./semantic-tiebreaker.ts";
import { canonicalize } from "./url-utils.ts";

/** Buckets do pool editorial cobertos pelo replay (mesmo recorte da #5995). */
export const REPLAY_TRACKED_BUCKETS: readonly Bucket[] = ["lancamento", "radar", "use_melhor"];

const TIEBREAKER_RULE_PREFIX = "semantic-tiebreaker-";

export interface ReplayArticleLike {
  url?: string;
  title?: string;
  /** #9380: título cru da fonte, gravado quando a normalização mudou o título.
   *  O categorizador decide sobre o título CRU — o replay também. */
  title_raw?: string;
  category_rule?: string;
  [key: string]: unknown;
}

export interface ReplayBucketsInput {
  lancamento?: ReplayArticleLike[];
  radar?: ReplayArticleLike[];
  use_melhor?: ReplayArticleLike[];
  [key: string]: unknown;
}

export interface ReplayItem {
  edition: string;
  url: string;
  title: string;
  /** Bucket em que o editor deixou o item (gabarito). */
  approved: Bucket;
  /** Bucket que o categorizador deu na época (congelado em 01-categorized.json). */
  frozen: Bucket;
  frozenRule: string | null;
  /** Bucket que o código ATUAL dá ao mesmo input. */
  replay: Bucket;
  replayRule: string;
  /** true quando o veredito do tie-breaker congelado foi reaproveitado (limitação 1). */
  tiebreakerReused: boolean;
}

export type CategorizeFn = (article: Article) => CategorizationResult;

function indexApproved(approved: ReplayBucketsInput): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const bucket of REPLAY_TRACKED_BUCKETS) {
    const articles = approved[bucket];
    if (!Array.isArray(articles)) continue;
    for (const a of articles) {
      if (a && typeof a.url === "string" && a.url) map.set(canonicalize(a.url), bucket);
    }
  }
  return map;
}

/**
 * Reaplica o tie-breaker congelado: `category_rule` grava o veredito
 * (`-lancamento`/`-radar-nonofficial` = classificador disse lançamento;
 * `-radar` = disse radar). Recompõe só o gate de domínio oficial.
 */
function recomposeTiebreaker(frozenRule: string, url: string): { bucket: Bucket; rule: string } {
  const verdict: TieBreakerVerdict = frozenRule === `${TIEBREAKER_RULE_PREFIX}radar` ? "radar" : "lancamento";
  const composed = composeWithOfficialDomainGate(verdict, url);
  if (composed === "lancamento") return { bucket: "lancamento", rule: `${TIEBREAKER_RULE_PREFIX}lancamento` };
  return {
    bucket: "radar",
    rule: verdict === "lancamento" ? `${TIEBREAKER_RULE_PREFIX}radar-nonofficial` : `${TIEBREAKER_RULE_PREFIX}radar`,
  };
}

/**
 * Replay de UMA edição. Join por URL canonicalizada; item que só existe de um
 * lado (cortado, promovido a destaque, adicionado à mão) fica de fora — não
 * há gabarito de seção pra ele.
 */
export function replayEdition(
  edition: string,
  categorized: ReplayBucketsInput,
  approved: ReplayBucketsInput,
  categorizeFn: CategorizeFn = categorizeWithRule,
): ReplayItem[] {
  const approvedIndex = indexApproved(approved);
  const items: ReplayItem[] = [];
  const seen = new Set<string>();

  for (const frozen of REPLAY_TRACKED_BUCKETS) {
    const articles = categorized[frozen];
    if (!Array.isArray(articles)) continue;
    for (const a of articles) {
      if (!a || typeof a.url !== "string" || !a.url) continue;
      const key = canonicalize(a.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const approvedBucket = approvedIndex.get(key);
      if (!approvedBucket) continue;

      const rawTitle = typeof a.title_raw === "string" ? a.title_raw : a.title;
      const input = { ...a, title: rawTitle } as Article;
      const result = categorizeFn(input);
      let replay = categoryToBucket(result.category);
      let replayRule: string = result.rule;
      let tiebreakerReused = false;
      const frozenRule = typeof a.category_rule === "string" ? a.category_rule : null;
      if (frozenRule?.startsWith(TIEBREAKER_RULE_PREFIX) && isFallbackCategorizationRule(result.rule)) {
        const re = recomposeTiebreaker(frozenRule, a.url);
        replay = re.bucket;
        replayRule = re.rule;
        tiebreakerReused = true;
      }
      // Mesma regra que a congelada ⇒ mesma decisão do categorizador. Se o
      // bucket congelado diverge do que a regra implica, foi um passo
      // DOWNSTREAM do Stage 1 (não o categorizador) que moveu o item — medido
      // no corpus em 08/10/2026: 21 itens `lancamento-default`/
      // `semantic-tiebreaker-lancamento` já gravados em `radar`. O replay
      // preserva esse bucket em vez de acusar regressão falsa.
      if (frozenRule !== null && replayRule === frozenRule) replay = frozen;

      items.push({
        edition,
        url: a.url,
        title: (a.title as string | undefined) ?? "",
        approved: approvedBucket,
        frozen,
        frozenRule,
        replay,
        replayRule,
        tiebreakerReused,
      });
    }
  }
  return items;
}

export interface DirectionResidual {
  /** "congelado->editor" */
  direction: string;
  /** Movimentos do editor nessa direção. */
  moves: number;
  /** Desses, quantos o código atual ainda erra. */
  residual: number;
}

export interface ReplaySummary {
  editions: number;
  pairs: number;
  frozenAgree: number;
  replayAgree: number;
  /** Congelado errado, replay certo. */
  improvements: ReplayItem[];
  /** Congelado certo, replay errado — o que um ajuste novo quebrou. */
  regressions: ReplayItem[];
  /** Movimentos do editor (frozen ≠ approved) que o replay AINDA erra. */
  residualItems: ReplayItem[];
  directions: DirectionResidual[];
  tiebreakerReused: number;
}

export function summarizeReplay(items: ReplayItem[]): ReplaySummary {
  const byDirection = new Map<string, DirectionResidual>();
  const improvements: ReplayItem[] = [];
  const regressions: ReplayItem[] = [];
  const residualItems: ReplayItem[] = [];
  let frozenAgree = 0;
  let replayAgree = 0;
  let tiebreakerReused = 0;

  for (const it of items) {
    const frozenOk = it.frozen === it.approved;
    const replayOk = it.replay === it.approved;
    if (frozenOk) frozenAgree++;
    if (replayOk) replayAgree++;
    if (it.tiebreakerReused) tiebreakerReused++;
    if (!frozenOk && replayOk) improvements.push(it);
    if (frozenOk && !replayOk) regressions.push(it);
    if (!frozenOk) {
      const direction = `${it.frozen}->${it.approved}`;
      const d = byDirection.get(direction) ?? { direction, moves: 0, residual: 0 };
      d.moves++;
      if (!replayOk) {
        d.residual++;
        residualItems.push(it);
      }
      byDirection.set(direction, d);
    }
  }

  return {
    editions: new Set(items.map((i) => i.edition)).size,
    pairs: items.length,
    frozenAgree,
    replayAgree,
    improvements,
    regressions,
    residualItems,
    directions: [...byDirection.values()].sort((a, b) => b.moves - a.moves || a.direction.localeCompare(b.direction)),
    tiebreakerReused,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "0.00" : ((n / d) * 100).toFixed(2);
}

function itemLine(it: ReplayItem): string {
  return `  - ${it.edition} ${it.frozen}->${it.approved} (replay: ${it.replay}, ${it.replayRule}) ${it.title || "(sem título)"} — ${it.url}`;
}

export function renderReplayReport(s: ReplaySummary, window: number | null): string {
  const lines: string[] = [];
  const scope = window ? `últimas ${window} edições` : "corpus inteiro";
  lines.push(`REPLAY DO CATEGORIZADOR (#9882) — ${scope}: ${s.editions} edições, ${s.pairs} pares item×gabarito`);
  lines.push(`  acordo congelado (o que rodou na época): ${s.frozenAgree} (${pct(s.frozenAgree, s.pairs)}%)`);
  lines.push(`  acordo replay (código atual):            ${s.replayAgree} (${pct(s.replayAgree, s.pairs)}%)`);
  lines.push(`  melhorias: ${s.improvements.length} · regressões: ${s.regressions.length}`);
  lines.push(`  veredito do tie-breaker reaproveitado (#8211, não roda offline): ${s.tiebreakerReused}`);
  lines.push("");
  lines.push("MOVIMENTOS DO EDITOR × RESÍDUO (quantos o código atual ainda erra):");
  for (const d of s.directions) {
    lines.push(`  ${d.direction.padEnd(26)} ${String(d.moves).padStart(4)} movimentos · resíduo ${d.residual}`);
  }
  const totalMoves = s.directions.reduce((n, d) => n + d.moves, 0);
  const totalResidual = s.directions.reduce((n, d) => n + d.residual, 0);
  lines.push(`  ${"TOTAL".padEnd(26)} ${String(totalMoves).padStart(4)} movimentos · resíduo ${totalResidual}`);
  lines.push("");
  if (s.regressions.length > 0) {
    lines.push("REGRESSÕES (congelado acertava, código atual erra):");
    for (const it of s.regressions) lines.push(itemLine(it));
    lines.push("");
  }
  if (s.residualItems.length > 0) {
    lines.push("RESÍDUO (movimento do editor que o código atual ainda erra):");
    for (const it of s.residualItems) lines.push(itemLine(it));
    lines.push("");
  }
  return lines.join("\n");
}
